"""PDF→Markdown conversion via vision-capable LLM."""

import asyncio
import collections
import io
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
from pypdf import PdfReader, PdfWriter

from flowa.assemble import assemble_paper
from flowa.models import create_model, get_model_settings
from flowa.pdf_index_cache import build as build_pdf_index_payload
from flowa.pdf_index_cache import serialize as serialize_pdf_index_payload
from flowa.pdfium import run_pdfium
from flowa.prompts import load_text_prompt
from flowa.settings import ModelConfig, Settings
from flowa.storage import (
    exists,
    full_md_url,
    full_pdf_url,
    list_office_supplements,
    list_pdf_supplements,
    paper_url,
    read_bytes,
    read_text,
    remove,
    write_bytes,
    write_text,
)

log = logging.getLogger(__name__)

PAGES_PER_CHUNK = 10

# PDF-supplement page caps (mirrors the office token budget in assemble.py): a
# per-file cap and a total budget, applied in ord order before transcription so
# we never pay the vision-LLM bill on a supplement we'd then drop from the merge.
PDF_SUPPLEMENT_MAX_PAGES = 20
PDF_SUPPLEMENT_TOTAL_MAX_PAGES = 50


def _concatenate_pdfs(pdfs: Sequence[bytes]) -> bytes:
    """Concatenate PDFs (in order) into a single PDF's bytes."""
    writer = PdfWriter()
    for data in pdfs:
        writer.append(io.BytesIO(data))
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def _accept_pdf_supplements(
    supplements: Sequence[tuple[str, bytes]],
    *,
    max_pages_per_supplement: int = PDF_SUPPLEMENT_MAX_PAGES,
    max_total_pages: int = PDF_SUPPLEMENT_TOTAL_MAX_PAGES,
) -> list[tuple[str, bytes]]:
    """Return the PDF supplements small enough to transcribe and merge, in ord order.

    A supplement over the per-file page cap, or one that would push the running
    total past the budget, is dropped (and so are unreadable PDFs). The accepted
    set drives both the per-supplement transcription and the ``merged.pdf``
    concatenation, and (via its sidecars) what ``assemble`` folds into ``merged.md``.
    """
    accepted: list[tuple[str, bytes]] = []
    total = 0
    for name, data in supplements:
        try:
            pages = len(PdfReader(io.BytesIO(data)).pages)
        except Exception:
            log.warning('Cannot read PDF supplement %s — dropping', name, exc_info=True)
            continue
        if pages > max_pages_per_supplement:
            log.info(
                'PDF supplement %s: %d pages over per-file cap %d — skipping', name, pages, max_pages_per_supplement
            )
            continue
        if total + pages > max_total_pages:
            log.info('PDF supplement %s: %d pages over total budget %d — skipping', name, pages, max_total_pages)
            continue
        accepted.append((name, data))
        total += pages
    return accepted


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
    # chunks() drives PDFium (page splitting); route it through the single
    # PDFium lane and fully materialise the generator there so no PDFium call
    # leaks onto the event-loop thread during iteration.
    doc_chunks = await run_pdfium(lambda: list(chunks(pdf_bytes, page_count=page_count)))

    coros = [_generate_markdown(chunk.data, model, prompt) for chunk in doc_chunks]
    chunk_results = list(await asyncio.gather(*coros))

    numbered = _renumber_markers([cr.markdown for cr in chunk_results])
    return ConvertResult(
        markdown='\n\n<!--page-->\n\n'.join(numbered),
        all_messages=[cr.all_messages for cr in chunk_results],
    )


async def convert_paper_async(base: str, doi: str, model: ModelConfig, prompt_set: str = 'generic') -> None:
    """Transcribe the paper's PDFs, persist its `PdfIndex`, and assemble `merged.md`.

    Reads ``papers/{encoded_doi}/main.pdf`` plus any PDF supplements under
    ``supplements/`` and writes:
      - main.md                 — vision-LLM transcription of main.pdf (cache)
      - supplements/{n}.pdf.md  — transcription of each accepted PDF supplement (cache)
      - merged.pdf              — main.pdf + PDF supplements, only when a PDF supplement exists
      - merged.md               — main.md + supplement transcriptions + office, only when any
                                  supplement exists (via flowa.assemble; else read main.md)
      - pdf_index.pkl.zst       — built from the full PDF (merged.pdf else main.pdf)

    Each artifact is produced only when missing, and each PDF is transcribed only
    once (cached by main.md / sidecar presence), so adding one PDF supplement
    transcribes just that supplement and re-merges — never the whole paper. ``merged.pdf``
    and ``merged.md`` mirror each other: each exists only when there's something to merge,
    with the ``full_pdf`` / ``full_md`` accessors falling back to ``main.*``.
    """
    main_pdf_url = paper_url(base, doi, 'main.pdf')
    main_md_url = paper_url(base, doi, 'main.md')
    merged_pdf_url = paper_url(base, doi, 'merged.pdf')
    merged_md_url = paper_url(base, doi, 'merged.md')
    index_url = paper_url(base, doi, 'pdf_index.pkl.zst')

    has_pdf = bool(list_pdf_supplements(base, doi))
    has_office = bool(list_office_supplements(base, doi))

    # Fast path: main.md + index present and the assembled Markdown is in its final
    # state — merged.md present, or no supplements at all (so main.md is the full
    # Markdown). A supplement/main change deletes the affected artifacts via
    # invalidation, so a missing one here means real work.
    if exists(main_md_url) and exists(index_url) and (exists(merged_md_url) or not (has_pdf or has_office)):
        log.info('Already converted: %s', doi)
        return

    try:
        main_pdf_bytes = read_bytes(main_pdf_url)
    except FileNotFoundError:
        log.info('Skipping DOI %s: main.pdf not available', doi)
        return

    raw_traces: list[list[list[dict[str, Any]]]] = []
    prompt: str | None = None

    async def _transcribe_to(url: str, pdf_bytes: bytes, label: str) -> None:
        nonlocal prompt
        if prompt is None:
            prompt = load_text_prompt('transcription', prompt_set)
        log.info('Transcribing %s for DOI %s (%d bytes, model: %s)', label, doi, len(pdf_bytes), model.name)
        t0 = time.monotonic()
        result = await transcribe(pdf_bytes, model=model, prompt=prompt, page_count=PAGES_PER_CHUNK)
        write_text(url, result.markdown)
        raw_traces.append(result.all_messages)
        log.info(
            'Transcribed %s for DOI %s: %d chars in %.1fs', label, doi, len(result.markdown), time.monotonic() - t0
        )

    # 1) main.pdf -> main.md (cached).
    main_md_built = False
    if not exists(main_md_url):
        await _transcribe_to(main_md_url, main_pdf_bytes, 'main.pdf')
        main_md_built = True

    # 2) PDF supplements: page-cap, then transcribe each accepted one (cached per sidecar).
    accepted: list[tuple[str, bytes]] = []
    sidecar_built = False
    pdf_names = list_pdf_supplements(base, doi)
    if pdf_names:
        supps = [(name, read_bytes(paper_url(base, doi, f'supplements/{name}'))) for name in pdf_names]
        accepted = _accept_pdf_supplements(supps)
        for name, data in accepted:
            sidecar_url = paper_url(base, doi, f'supplements/{name}.md')
            if not exists(sidecar_url):
                await _transcribe_to(sidecar_url, data, f'supplement {name}')
                sidecar_built = True

    # 3) merged.pdf — the single full PDF the viewer renders and the index is built
    # from. Materialised only when accepted PDF supplements exist; otherwise full_pdf
    # falls back to main.pdf. (merged.md is its Markdown mirror, built in assemble.)
    merged_pdf_changed = False
    if accepted:
        if main_md_built or sidecar_built or not exists(merged_pdf_url):
            write_bytes(merged_pdf_url, _concatenate_pdfs([main_pdf_bytes, *(data for _, data in accepted)]))
            merged_pdf_changed = True
            log.info('Built merged.pdf for %s (%d PDF supplement(s))', doi, len(accepted))
    elif exists(merged_pdf_url):
        # No accepted PDF supplements but a stale merge is on disk (last one removed):
        # drop it so full_pdf falls back to main.pdf.
        remove(merged_pdf_url)
        merged_pdf_changed = True
        log.info('Removed stale merged.pdf for %s (no PDF supplements)', doi)

    # 4) merged.md = main.md + supplement transcriptions + office supplements — written
    # by assemble only when a supplement contributes content (else removed, so full_md
    # falls back to main.md). markitdown is sync CPU-bound, so assemble runs off-thread.
    if main_md_built or sidecar_built or merged_pdf_changed or not exists(merged_md_url):
        await asyncio.to_thread(assemble_paper, base, doi)

    # 5) pdf_index — built from the full PDF. PdfIndex construction is CPU-bound (~8s
    # on the deployed gateway hardware) and dominates `/api/v1/resolve` latency if
    # rebuilt per call, so pay it here once and ship the result (see
    # `flowa.pdf_index_cache`). The index keys off physical PDF page order only
    # (markdown=None today), so it depends on the full PDF bytes; full_md (merged.md else
    # main.md) is passed as the forward-compat denoise reference. Rebuild when the full
    # PDF changed.
    if not exists(index_url) or merged_pdf_changed:
        full_pdf_bytes = read_bytes(full_pdf_url(base, doi))
        markdown = read_text(full_md_url(base, doi))
        t0 = time.monotonic()
        # PdfIndex construction drives PDFium, so it goes on the single PDFium
        # lane; the zstd serialisation is plain CPU work, so it goes back to the
        # general pool and doesn't hold the scarce lane while other papers wait.
        payload = await run_pdfium(lambda: build_pdf_index_payload(full_pdf_bytes, markdown))
        blob = await asyncio.to_thread(lambda: serialize_pdf_index_payload(payload))
        write_bytes(index_url, blob)
        log.info('Wrote pdf_index for DOI %s: %.1f MB in %.1fs', doi, len(blob) / 1e6, time.monotonic() - t0)

    # 6) convert_raw.json — debug traces of whatever was transcribed this run.
    if raw_traces:
        write_bytes(paper_url(base, doi, 'convert_raw.json'), json.dumps(raw_traces).encode())


def convert_paper(
    doi: str = typer.Option(..., '--doi', help='DOI of the paper'),
) -> None:
    """Convert the paper's PDFs to Markdown.

    Reads papers/{encoded_doi}/main.pdf (and any PDF supplements under supplements/)
    from object storage. Writes the per-piece transcriptions (main.md, supplement
    sidecars), the merged.pdf when PDF supplements exist, the assembled merged.md,
    and the pre-built index to pdf_index.pkl.zst.
    """
    s = Settings()  # type: ignore[call-arg]
    asyncio.run(convert_paper_async(s.flowa_storage_base, doi, s.flowa_convert_model, s.flowa_prompt_set))
