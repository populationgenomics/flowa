"""Storage path helpers for Flowa.

Uses fsspec with S3/MinIO (s3://) or GCS (gs://).

Storage layout (DOIs are percent-encoded via encode_doi()):
    papers/{encoded_doi}/
        source.pdf
        source_hash.txt
        markdown.md
        metadata.json

    assessments/{variant_id}/
        workflow.json
        variant_details.json
        query.json
        aggregate.json
        aggregate_raw.json
        extractions/{encoded_doi}.json
        extractions/{encoded_doi}_raw.json

Usage:
    from flowa.storage import paper_url, assessment_url, read_json, write_json

    base = settings.flowa_storage_base
    metadata = read_json(paper_url(base, '10.1038/s41586-020-2308-7', 'metadata.json'))
    write_json(assessment_url(base, 'var123', 'aggregate.json'), result)
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
