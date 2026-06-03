"""Storage path helpers for Flowa.

Uses fsspec with S3/MinIO (s3://) or GCS (gs://).

Storage layout (DOIs are percent-encoded via encode_doi()):
    papers/{encoded_doi}/
        main.pdf            # raw main paper PDF (always)
        main.md             # vision-LLM transcription of main.pdf (always)
        merged.pdf          # main.pdf + PDF supplements concatenated — only when a PDF supplement exists
        merged.md           # main.md + PDF-supplement transcriptions + office — only when any supplement exists
        pdf_index.pkl.zst   # built from the full PDF (merged.pdf else main.pdf)
        metadata.json
        supplements/        # user uploads (office + PDF) plus *.pdf.md transcription sidecars

    assessments/{variant_id}/
        workflow.json
        variant_details.json
        query.json
        aggregation.json
        aggregation_raw.json
        extractions/{encoded_doi}.json
        extractions/{encoded_doi}_raw.json

Usage:
    from flowa.storage import paper_url, assessment_url, read_json, write_json

    base = settings.flowa_storage_base
    metadata = read_json(paper_url(base, '10.1038/s41586-020-2308-7', 'metadata.json'))
    write_json(assessment_url(base, 'var123', 'aggregation.json'), result)
"""

import json
from typing import Any
from urllib.parse import quote

import fsspec  # type: ignore[import-untyped]


def encode_doi(doi: str) -> str:
    """Percent-encode a DOI for safe use in storage paths and filenames."""
    return quote(doi, safe='')


def exists(url: str) -> bool:
    """Check if a file exists in storage."""
    fs, path = fsspec.core.url_to_fs(url)
    return fs.exists(path)


def paper_url(base: str, doi: str, filename: str) -> str:
    """Build URL for corpus-wide paper files (shared across variants).

    The DOI is percent-encoded so special characters don't interfere with
    storage paths (see encode_doi()).

    Examples:
        paper_url('s3://bucket', '10.1038/s41586-020-2308-7', 'source.pdf')
        -> 's3://bucket/papers/10.1038%2Fs41586-020-2308-7/source.pdf'
    """
    return f'{base.rstrip("/")}/papers/{encode_doi(doi)}/{filename}'


def assessment_url(base: str, variant_id: str, *parts: str) -> str:
    """Build URL for variant-specific assessment files.

    Examples:
        assessment_url('s3://bucket', 'var123', 'workflow.json')
        -> 's3://bucket/assessments/var123/workflow.json'

        assessment_url('s3://bucket', 'var123', 'extractions', '12345678.json')
        -> 's3://bucket/assessments/var123/extractions/12345678.json'
    """
    return '/'.join([base.rstrip('/'), 'assessments', variant_id, *parts])


def read_json(url: str) -> Any:
    """Read and parse JSON from a storage URL."""
    with fsspec.open(url, 'r') as f:
        return json.load(f)


def write_json(url: str, data: Any) -> None:
    """Write data as JSON to a storage URL."""
    with fsspec.open(url, 'w') as f:
        json.dump(data, f, indent=2)


def read_text(url: str) -> str:
    """Read text from a storage URL."""
    with fsspec.open(url, 'r') as f:
        return f.read()


def read_bytes(url: str) -> bytes:
    """Read raw bytes from a storage URL."""
    with fsspec.open(url, 'rb') as f:
        return f.read()


def write_bytes(url: str, data: bytes) -> None:
    """Write raw bytes to a storage URL."""
    with fsspec.open(url, 'wb') as f:
        f.write(data)


def write_text(url: str, text: str) -> None:
    """Write text to a storage URL."""
    with fsspec.open(url, 'w') as f:
        f.write(text)


def remove(url: str) -> None:
    """Delete a file at a storage URL if it exists (no-op when already absent)."""
    fs, path = fsspec.core.url_to_fs(url)
    if fs.exists(path):
        fs.rm(path)


def full_pdf_url(base: str, doi: str) -> str:
    """URL of the full paper PDF: ``merged.pdf`` if present, else ``main.pdf``.

    ``merged.pdf`` (main.pdf + PDF supplements, concatenated by ``flowa.convert``)
    exists only when the paper carries at least one PDF supplement; otherwise the
    main PDF is the full PDF. This is the single file the viewer renders and
    ``pdf_index`` is built from.
    """
    merged = paper_url(base, doi, 'merged.pdf')
    return merged if exists(merged) else paper_url(base, doi, 'main.pdf')


def full_md_url(base: str, doi: str) -> str:
    """URL of the full assembled Markdown: ``merged.md`` if present, else ``main.md``.

    The Markdown analogue of :func:`full_pdf_url`. ``merged.md`` (main.md +
    PDF-supplement transcriptions + converted office supplements, built by
    ``flowa.assemble``) exists only when the paper carries at least one supplement
    (PDF *or* office); otherwise ``main.md`` — the main-PDF transcription — is the full
    Markdown. This is the consumer-facing artifact extract/aggregate read and the
    viewer renders; ``markdown_anchor`` offsets index into it. ``main.md`` is always a
    prefix of ``merged.md`` (supplements are appended), so an offset into the
    main-paper region is valid against either.
    """
    merged = paper_url(base, doi, 'merged.md')
    return merged if exists(merged) else paper_url(base, doi, 'main.md')


_OFFICE_SUFFIXES = ('.xlsx', '.xls', '.docx')


def _list_supplements(base: str, doi: str) -> list[str]:
    """All basenames under ``papers/{doi}/supplements/``, sorted by ``ord`` prefix."""
    url = paper_url(base, doi, 'supplements')
    fs, path = fsspec.core.url_to_fs(url)
    if not fs.exists(path):
        return []
    return sorted(entry.rstrip('/').rsplit('/', 1)[-1] for entry in fs.ls(path, detail=False))


def list_office_supplements(base: str, doi: str) -> list[str]:
    """Office supplement basenames (xlsx/xls/docx) under ``supplements/``, in ord order.

    These are converted to Markdown by ``flowa.assemble`` and appended to
    ``merged.md``. PDF supplements and their ``*.pdf.md`` transcription sidecars are
    excluded — those go through the vision-LLM merge in ``flowa.convert``, not
    markitdown. Read a supplement's bytes back via
    ``read_bytes(paper_url(base, doi, f'supplements/{name}'))``.
    """
    return [n for n in _list_supplements(base, doi) if n.lower().endswith(_OFFICE_SUFFIXES)]


def list_pdf_supplements(base: str, doi: str) -> list[str]:
    """PDF supplement basenames (``*.pdf``) under ``supplements/``, in ord order.

    Excludes the ``*.pdf.md`` transcription sidecars that ``flowa.convert`` caches
    alongside each raw PDF supplement (those end in ``.md``, not ``.pdf``).
    """
    return [n for n in _list_supplements(base, doi) if n.lower().endswith('.pdf')]
