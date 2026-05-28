"""PDF→Markdown conversion via vision-capable LLM."""

import asyncio
import collections
import json
import logging
import re
import time
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

import typer
from anchorite.document import chunks  # type: ignore[import-untyped]
from pydantic_ai import Agent
from pydantic_ai.messages import BinaryContent

from flowa.models import create_model, get_model_settings
from flowa.pdf_index_cache import build as build_pdf_index_payload
from flowa.pdf_index_cache import serialize as serialize_pdf_index_payload
from flowa.prompts import load_text_prompt
from flowa.settings import ModelConfig, Settings
from flowa.storage import exists, paper_url, read_bytes, read_text, write_bytes, write_text

log = logging.getLogger(__name__)

PAGES_PER_CHUNK = 10


# Strip the line-number prefixes the transcription prompt asks the model to
# emit. Those prefixes are a content-filter bypass: faithfully transcribing a
# PDF isn't creative enough for Claude's anti-regurgitation heuristic on its
# own, but prepending line numbers gives the model something "original" to
# contribute. The prompt instructs it to add them; this regex removes them.
# https://privacy.claude.com/en/articles/10023638-why-am-i-receiving-an-output-blocked-by-content-filtering-policy-error
_LINE_NUM_RE = re.compile(r'^\d+\|', re.MULTILINE)

_agent: Agent[None, str] = Agent(output_type=str)

# Cap transcription output well above what a 10-page Markdown chunk produces
# (typically 10-20K tokens).
_TRANSCRIBE_MAX_TOKENS = 64_000


def _renumber_markers(markdown_chunks: Sequence[str]) -> list[str]:
    """Renumber ``<!--table-->`` and ``<!--figure-->`` markers across chunks.

    Transforms e.g. ``<!--table-->`` into ``<!--table: 1-->``, with counters
    running across all chunks so numbering is document-wide.
    """
    counters: collections.Counter[str] = collections.Counter()

    def _renumber(match: re.Match[str]) -> str:
        kind = match.group(1)
        counters[kind] += 1
        return f'<!--{kind}: {counters[kind]}-->'

    return [re.sub(r'<!--(table|figure)-->', _renumber, chunk) for chunk in markdown_chunks]


@dataclass(frozen=True)
class _ChunkResult:
    markdown: str
    all_messages: list[dict[str, Any]]


async def _generate_markdown(chunk_bytes: bytes, model: ModelConfig, prompt: str) -> _ChunkResult:
    """Convert a single PDF chunk to Markdown via a vision-capable LLM."""
    # Stream so bytes flow during long transcription chunks; otherwise the
    # connection goes silent for minutes and trips our Bedrock read_timeout.
    async with _agent.run_stream(
        [BinaryContent(data=chunk_bytes, media_type='application/pdf'), prompt],
        model=create_model(model),
        model_settings=get_model_settings(model, max_tokens=_TRANSCRIBE_MAX_TOKENS),
    ) as stream_result:
        output = await stream_result.get_output()
        raw_messages_json = stream_result.all_messages_json()
    # Strip the line-number prefixes added to bypass Claude's content filter.
    markdown = _LINE_NUM_RE.sub('', output)
    # NFKC-normalize so superscript digits, ligatures, etc. match the
    # normalized character text extracted from PDFs by pypdfium2.
    all_messages: list[dict[str, Any]] = json.loads(raw_messages_json)
    return _ChunkResult(
        markdown=unicodedata.normalize('NFKC', markdown),
        all_messages=all_messages,
    )


@dataclass(frozen=True)
class ConvertResult:
    """Result of converting a PDF to Markdown."""

    markdown: str
    """Plain Markdown with ``<!--page-->`` markers between pages."""
    all_messages: list[list[dict[str, Any]]]
    """LLM conversation traces per chunk (requests, responses, usage)."""


async def transcribe(
    pdf_bytes: bytes,
    *,
    model: ModelConfig,
    prompt: str,
    page_count: int | None = None,
) -> ConvertResult:
    """Convert a PDF to plain Markdown via vision-capable LLM.

    Splits the PDF into chunks (``page_count`` pages each), converts each chunk
    concurrently, then joins the results with ``<!--page-->`` separators.
    """
    doc_chunks = list(chunks(pdf_bytes, page_count=page_count))

    coros = [_generate_markdown(chunk.data, model, prompt) for chunk in doc_chunks]
    chunk_results = list(await asyncio.gather(*coros))

    numbered = _renumber_markers([cr.markdown for cr in chunk_results])
    return ConvertResult(
        markdown='\n\n<!--page-->\n\n'.join(numbered),
        all_messages=[cr.all_messages for cr in chunk_results],
    )


async def convert_paper_async(base: str, doi: str, model: ModelConfig, prompt_set: str = 'generic') -> None:
    """Convert a single paper's PDF to Markdown and persist its `PdfIndex`.

    Reads PDF from papers/{encoded_doi}/source.pdf and writes
    papers/{encoded_doi}/markdown.md plus papers/{encoded_doi}/pdf_index.pkl.zst
    (consumed by the gateway's resolve endpoint).

    Either artifact can be missing independently — if a previous run failed
    or pre-dates the pdf_index step, the next call fills in only what's
    missing without re-transcribing or re-building work that's already done.
    """
    md_url = paper_url(base, doi, 'markdown.md')
    index_url = paper_url(base, doi, 'pdf_index.pkl.zst')
    md_needed = not exists(md_url)
    index_needed = not exists(index_url)

    if not md_needed and not index_needed:
        log.info('Already converted: %s', md_url)
        return

    pdf_url = paper_url(base, doi, 'source.pdf')
    try:
        pdf_bytes = read_bytes(pdf_url)
    except FileNotFoundError:
        log.info('Skipping DOI %s: PDF not available', doi)
        return

    markdown: str | None = None
    if md_needed:
        log.info(
            'Converting DOI %s (%d bytes, model: %s, chunk: %d pages)', doi, len(pdf_bytes), model.name, PAGES_PER_CHUNK
        )
        prompt = load_text_prompt('transcription', prompt_set)
        t0 = time.monotonic()
        result = await transcribe(pdf_bytes, model=model, prompt=prompt, page_count=PAGES_PER_CHUNK)
        elapsed = time.monotonic() - t0

        markdown = result.markdown
        write_text(md_url, markdown)
        write_bytes(paper_url(base, doi, 'convert_raw.json'), json.dumps(result.all_messages).encode())
        log.info('Converted DOI %s: %d chars in %.1fs', doi, len(markdown), elapsed)

    if index_needed:
        # PdfIndex construction is CPU-bound (~8s on the deployed gateway
        # hardware) and dominates per-call latency at `/api/v1/resolve` if
        # rebuilt on every call. Pay the cost here once per paper and ship
        # the result; see `flowa.pdf_index_cache` for the storage format.
        # `asyncio.to_thread` keeps the rest of the convert pipeline (other
        # papers being transcribed concurrently) unblocked.
        if markdown is None:  # index missing but markdown already on disk
            markdown = read_text(md_url)
        t0 = time.monotonic()
        blob = await asyncio.to_thread(
            lambda: serialize_pdf_index_payload(build_pdf_index_payload(pdf_bytes, markdown))
        )
        write_bytes(index_url, blob)
        log.info('Wrote pdf_index for DOI %s: %.1f MB in %.1fs', doi, len(blob) / 1e6, time.monotonic() - t0)


def convert_paper(
    doi: str = typer.Option(..., '--doi', help='DOI of the paper'),
) -> None:
    """Convert PDF to Markdown.

    Reads PDF from papers/{encoded_doi}/source.pdf in object storage.
    Stores result to papers/{encoded_doi}/markdown.md.
    """
    s = Settings()  # type: ignore[call-arg]
    asyncio.run(convert_paper_async(s.flowa_storage_base, doi, s.flowa_convert_model, s.flowa_prompt_set))
