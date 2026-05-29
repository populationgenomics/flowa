"""Assemble ``markdown.md`` from ``source.md`` plus converted xlsx/docx supplements.

``source.md`` is the vision-LLM transcription of ``source.pdf``; ``markdown.md`` is
the consumer-facing artifact the extract/aggregate stages read and the viewer
renders. The split keeps supplement edits off the expensive transcription path:
re-running assemble rewrites only ``markdown.md``, never ``source.md`` or
``pdf_index.pkl.zst``.

Supplements are converted with markitdown (xlsx/xls/docx) and appended under
``<!--supplement: {filename}-->`` markers, in ``ord``-prefix order, subject to a
size policy. A supplement that fails to convert or would blow the budget is
dropped — partial coverage is strictly better than aborting the paper — and the
outcome is recorded on the ``flowa_supplements_processed_total`` counter.
"""

import io
import logging
from pathlib import Path

import logfire
import typer
from markitdown import MarkItDown

from flowa.settings import Settings
from flowa.storage import list_paper_supplements, paper_url, read_bytes, read_text, write_text

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


def _convert_supplement(filename: str, data: bytes) -> str:
    """Convert one supplement's bytes to Markdown via markitdown.

    The file extension drives converter dispatch (xlsx/xls/docx), so it is passed
    through to ``convert_stream``; no temp file is needed.
    """
    result = _markitdown.convert_stream(io.BytesIO(data), file_extension=Path(filename).suffix)
    return result.text_content


def assemble_paper(base: str, doi: str) -> None:
    """Build ``papers/{doi}/markdown.md`` from ``source.md`` + ``supplements/*``.

    ``markdown.md`` is ``source.md`` followed by each convertible supplement under
    a ``<!--supplement: {filename}-->`` marker, in ``ord`` order, within the size
    policy. No index is built: markdown_anchor resolution normalises
    ``markdown.md`` on demand (see ``flowa.resolve``).
    """
    source_md = read_text(paper_url(base, doi, 'source.md'))
    filenames = list_paper_supplements(base, doi)

    parts = [source_md]
    included = 0
    total_tokens = 0.0
    for i, filename in enumerate(filenames):
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
            remaining = len(filenames) - i
            log.info(
                'Token budget %d reached for %s — skipping %d remaining supplement(s)',
                TOTAL_TOKEN_BUDGET,
                doi,
                remaining,
            )
            for _ in range(remaining):
                _supplements_counter.add(1, {'status': 'skipped_total_budget'})
            break

        parts.append(f'<!--supplement: {filename}-->')
        parts.append(converted)
        total_tokens += tokens
        included += 1
        _supplements_counter.add(1, {'status': 'included'})

    write_text(paper_url(base, doi, 'markdown.md'), '\n\n'.join(parts))
    log.info(
        'Assembled markdown.md for %s: %d/%d supplements (~%.0f supplement tokens)',
        doi,
        included,
        len(filenames),
        total_tokens,
    )


def assemble(
    doi: str = typer.Option(..., '--doi', help='DOI of the paper'),
) -> None:
    """Assemble markdown.md from source.md + supplements for a single paper.

    Reads papers/{encoded_doi}/source.md and papers/{encoded_doi}/supplements/*,
    writes papers/{encoded_doi}/markdown.md.
    """
    s = Settings()  # type: ignore[call-arg]
    assemble_paper(s.flowa_storage_base, doi)
