"""Assemble ``merged.md`` from the paper's transcriptions plus office supplements.

``merged.md`` is the consumer-facing Markdown the extract/aggregate stages read and the
viewer renders — `main.md` (the main-PDF transcription) followed by each PDF supplement's
transcription sidecar (``supplements/{name}.md``, produced by ``flowa.convert``) and then
each converted **office** supplement (xlsx/xls/docx), all under
``<!--supplement: {filename}-->`` markers in ``ord`` order.

It is the Markdown analogue of ``merged.pdf`` and is **materialized only when the paper
has at least one supplement** that contributes content; for a no-supplement paper there
is no ``merged.md`` and consumers fall back to ``main.md`` (see
``flowa.storage.full_md_url``). That avoids duplicating the transcription, mirroring how
``merged.pdf`` exists only when a PDF supplement does.

The split between the transcription caches (``main.md`` + sidecars, written once by the
vision-LLM in ``flowa.convert``) and this assembled artifact keeps supplement edits off
the expensive transcription path: re-running assemble rewrites only ``merged.md``, never
the transcriptions or ``pdf_index.pkl.zst``.

Office supplements are converted with markitdown, subject to a size policy; one that
fails to convert or would blow the budget is dropped — partial coverage beats aborting
the paper — and the outcome is recorded on ``flowa_supplements_processed_total``. PDF
supplements are page-capped and transcribed in ``flowa.convert``, so a present sidecar
means the supplement was accepted; assemble just folds the sidecar in.
"""

import collections
import io
import logging
import re
from pathlib import Path

import logfire
import typer
from markitdown import MarkItDown

from flowa.settings import Settings
from flowa.storage import (
    exists,
    list_office_supplements,
    list_pdf_supplements,
    paper_url,
    read_bytes,
    read_text,
    remove,
    write_text,
)

log = logging.getLogger(__name__)

# Char-based token estimate, no tokenizer dependency (see specs/supplements.md).
_CHARS_PER_TOKEN = 4
PER_SUPPLEMENT_TOKEN_CAP = 30_000
TOTAL_TOKEN_BUDGET = 80_000

# One counter labelled by outcome, mirroring flowa_aggregate_validation_errors_total
# in aggregate.py. A no-op until logfire is configured (cli.py / production).
_supplements_counter = logfire.metric_counter(
    'flowa_supplements_processed_total',
    description='Supplements seen by assemble, labelled by outcome',
)

# Plugins disabled: only the built-in xlsx/xls/docx converters are needed, and
# plugins could pull in network or third-party converters the pipeline shouldn't run.
_markitdown = MarkItDown(enable_plugins=False)


_OFFICE_SUFFIXES = ('.xlsx', '.xls', '.docx')


def _renumber_existing_markers(markdown: str) -> str:
    """Renumber already-numbered ``<!--table: N-->`` / ``<!--figure: N-->`` document-wide.

    Each transcription piece (main.md, each PDF-supplement sidecar) is produced by its
    own vision-LLM call, so its table/figure numbering restarts at 1. After concatenating
    the pieces, re-number across the whole document so references stay unique. Office
    supplements carry no such markers, so the office section is untouched.
    """
    counters: collections.Counter[str] = collections.Counter()

    def _renumber(match: re.Match[str]) -> str:
        kind = match.group(1)
        counters[kind] += 1
        return f'<!--{kind}: {counters[kind]}-->'

    return re.sub(r'<!--(table|figure): \d+-->', _renumber, markdown)


def _convert_supplement(filename: str, data: bytes) -> str:
    """Convert one office supplement's bytes to Markdown via markitdown.

    The file extension drives converter dispatch (xlsx/xls/docx), so it is passed
    through to ``convert_stream``; no temp file is needed. PDF supplements are NOT
    handled here — they go through the vision-LLM merge in ``flowa.convert`` — so a
    non-office extension is a programming error (assemble only enumerates office
    supplements) and raises, rather than silently letting markitdown's PDF backend
    splice raw PDF text into ``merged.md``.
    """
    suffix = Path(filename).suffix
    if suffix.lower() not in _OFFICE_SUFFIXES:
        raise ValueError(f'_convert_supplement called with non-office supplement: {filename!r}')
    result = _markitdown.convert_stream(io.BytesIO(data), file_extension=suffix)
    return result.text_content


def assemble_paper(base: str, doi: str) -> None:
    """Build ``papers/{doi}/merged.md`` from the transcriptions + office supplements.

    ``merged.md`` is ``main.md`` + each accepted PDF supplement's transcription sidecar +
    each convertible **office** supplement, under ``<!--supplement: {filename}-->`` markers
    in ``ord`` order, within the size policy. It is written **only when a supplement
    actually contributes content**; otherwise any stale ``merged.md`` is removed and
    consumers fall back to ``main.md``. No index is built: markdown_anchor resolution
    normalises the Markdown on demand (see ``flowa.resolve``).
    """
    merged_md_url = paper_url(base, doi, 'merged.md')

    # PDF-supplement transcription parts: sidecars that convert produced for accepted
    # supplements (a present `.pdf.md` means the supplement passed the page cap).
    pdf_parts: list[tuple[str, str]] = []
    for name in list_pdf_supplements(base, doi):
        sidecar_url = paper_url(base, doi, f'supplements/{name}.md')
        if exists(sidecar_url):
            pdf_parts.append((name, read_text(sidecar_url)))

    # Office supplements (markitdown), under markers, within the size policy.
    office_names = list_office_supplements(base, doi)
    office_parts: list[str] = []
    included = 0
    total_tokens = 0.0
    for i, filename in enumerate(office_names):
        data = read_bytes(paper_url(base, doi, f'supplements/{filename}'))
        try:
            converted = _convert_supplement(filename, data)
        except Exception:
            # Any conversion failure (corrupt / encrypted / magic-bytes mismatch)
            # drops this supplement and keeps the rest, by design — partial
            # coverage beats aborting the paper. The counter keeps it observable.
            log.warning('Supplement conversion failed: %s/%s — dropping', doi, filename, exc_info=True)
            _supplements_counter.add(1, {'status': 'conversion_failed'})
            continue

        tokens = len(converted) / _CHARS_PER_TOKEN
        if tokens > PER_SUPPLEMENT_TOKEN_CAP:
            log.info(
                'Supplement %s/%s ~%.0f tokens over per-file cap %d — skipping',
                doi,
                filename,
                tokens,
                PER_SUPPLEMENT_TOKEN_CAP,
            )
            _supplements_counter.add(1, {'status': 'skipped_too_large'})
            continue
        if total_tokens + tokens > TOTAL_TOKEN_BUDGET:
            # Skip this one and everything after it: a partial table is worse than
            # a missing one — the curator can't tell which rows were dropped.
            remaining = len(office_names) - i
            log.info(
                'Token budget %d reached for %s — skipping %d remaining supplement(s)',
                TOTAL_TOKEN_BUDGET,
                doi,
                remaining,
            )
            for _ in range(remaining):
                _supplements_counter.add(1, {'status': 'skipped_total_budget'})
            break

        office_parts.append(f'<!--supplement: {filename}-->')
        office_parts.append(converted)
        total_tokens += tokens
        included += 1
        _supplements_counter.add(1, {'status': 'included'})

    # Nothing beyond main.md to add → no merged.md; consumers read main.md (full_md).
    if not pdf_parts and included == 0:
        remove(merged_md_url)
        log.info('No supplement content for %s — merged.md omitted (markdown is main.md)', doi)
        return

    transcription_parts = [read_text(paper_url(base, doi, 'main.md'))]
    for name, sidecar in pdf_parts:
        transcription_parts.append(f'<!--supplement: {name}-->\n\n{sidecar}')
    parts = [_renumber_existing_markers('\n\n<!--page-->\n\n'.join(transcription_parts))]
    parts.extend(office_parts)

    write_text(merged_md_url, '\n\n'.join(parts))
    log.info(
        'Assembled merged.md for %s: %d PDF + %d/%d office supplements (~%.0f office tokens)',
        doi,
        len(pdf_parts),
        included,
        len(office_names),
        total_tokens,
    )


def assemble(
    doi: str = typer.Option(..., '--doi', help='DOI of the paper'),
) -> None:
    """Assemble merged.md from the transcriptions + office supplements for a paper.

    Reads papers/{encoded_doi}/main.md, the PDF-supplement sidecars, and the office
    supplements under papers/{encoded_doi}/supplements/, and writes
    papers/{encoded_doi}/merged.md (or removes it when the paper has no supplements).
    """
    s = Settings()  # type: ignore[call-arg]
    assemble_paper(s.flowa_storage_base, doi)
