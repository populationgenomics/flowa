"""Storage path helpers for Flowa.

Uses fsspec with S3/MinIO (s3://) or GCS (gs://).

Configuration via environment:
    FLOWA_STORAGE_BASE - Base URL (e.g., s3://flowa-assessments, gs://flowa-bucket)

    For S3/MinIO (read automatically by fsspec):
        FSSPEC_S3_ENDPOINT_URL - Custom endpoint (e.g., http://localhost:10000 for MinIO)
        FSSPEC_S3_KEY          - Access key (or AWS_ACCESS_KEY_ID)
        FSSPEC_S3_SECRET       - Secret key (or AWS_SECRET_ACCESS_KEY)

    For GCS (read automatically by gcsfs):
        GOOGLE_APPLICATION_CREDENTIALS - Path to service account JSON file

Storage layout:
    papers/{pmid}/                     # Corpus-wide, shared across variants
        source.pdf
        source_hash.txt
        docling.json
        metadata.json

    assessments/{variant_id}/          # Variant-specific
        workflow.json
        mastermind_response.json
        aggregate.json
        aggregate_raw.json
        extractions/{pmid}.json
        extractions/{pmid}_raw.json
        extractions/{pmid}_bbox.json
        annotated/{pmid}.pdf

Usage:
    from flowa.storage import paper_url, assessment_url, read_json, write_json

    # Corpus-wide paper files
    metadata = read_json(paper_url(12345678, 'metadata.json'))

    # Variant-specific files
    write_json(assessment_url('var123', 'aggregate.json'), result)
"""

import json
import os
from typing import Any

import fsspec


def _get_base() -> str:
    base = os.environ.get('FLOWA_STORAGE_BASE')
    if not base:
        raise ValueError('FLOWA_STORAGE_BASE environment variable not set')
    return base.rstrip('/')


def exists(url: str) -> bool:
    """Check if a file exists in storage."""
    fs, path = fsspec.core.url_to_fs(url)
    return fs.exists(path)


def paper_url(pmid: int, filename: str) -> str:
    """Build URL for corpus-wide paper files (shared across variants).

    Examples:
        paper_url(12345678, 'source.pdf')
        -> 's3://bucket/papers/12345678/source.pdf'

        paper_url(12345678, 'docling.json')
        -> 's3://bucket/papers/12345678/docling.json'
    """
    return f'{_get_base()}/papers/{pmid}/{filename}'


def assessment_url(variant_id: str, *parts: str) -> str:
    """Build URL for variant-specific assessment files.

    Examples:
        assessment_url('var123', 'workflow.json')
        -> 's3://bucket/assessments/var123/workflow.json'

        assessment_url('var123', 'extractions', '12345678.json')
        -> 's3://bucket/assessments/var123/extractions/12345678.json'

        assessment_url('var123', 'annotated', '12345678.pdf')
        -> 's3://bucket/assessments/var123/annotated/12345678.pdf'
    """
    return '/'.join([_get_base(), 'assessments', variant_id, *parts])


def read_json(url: str) -> Any:
    """Read and parse JSON from a storage URL."""
    with fsspec.open(url, 'r') as f:
        return json.load(f)


def write_json(url: str, data: Any) -> None:
    """Write data as JSON to a storage URL."""
    with fsspec.open(url, 'w') as f:
        json.dump(data, f, indent=2)


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
