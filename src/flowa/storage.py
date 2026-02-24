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

Storage layout (DOIs are percent-encoded via encode_doi()):
    papers/{encoded_doi}/              # e.g. papers/10.1038%2Fs41586-020-2308-7/
        source.pdf
        source_hash.txt
        docling.json
        metadata.json

    assessments/{variant_id}/
        workflow.json
        mastermind_response.json
        aggregate.json
        aggregate_raw.json
        extractions/{encoded_doi}.json
        extractions/{encoded_doi}_raw.json
        extractions/{encoded_doi}_bbox.json
        annotated/{encoded_doi}.pdf

Usage:
    from flowa.storage import paper_url, assessment_url, read_json, write_json

    # Corpus-wide paper files
    metadata = read_json(paper_url('10.1038/s41586-020-2308-7', 'metadata.json'))

    # Variant-specific files
    write_json(assessment_url('var123', 'aggregate.json'), result)
"""

import json
import os
from typing import Any
from urllib.parse import quote

import fsspec


def encode_doi(doi: str) -> str:
    """Percent-encode a DOI for safe use in storage paths and filenames."""
    return quote(doi, safe='')


def _get_base() -> str:
    base = os.environ.get('FLOWA_STORAGE_BASE')
    if not base:
        raise ValueError('FLOWA_STORAGE_BASE environment variable not set')
    return base.rstrip('/')


def exists(url: str) -> bool:
    """Check if a file exists in storage."""
    fs, path = fsspec.core.url_to_fs(url)
    return fs.exists(path)


def paper_url(doi: str, filename: str) -> str:
    """Build URL for corpus-wide paper files (shared across variants).

    The DOI is percent-encoded so special characters don't interfere with
    storage paths (see encode_doi()).

    Examples:
        paper_url('10.1038/s41586-020-2308-7', 'source.pdf')
        -> 's3://bucket/papers/10.1038%2Fs41586-020-2308-7/source.pdf'

        paper_url('10.1002/(SICI)1098-1004(200001)15:1<121::AID-HUMU37>3.0.CO;2-U', 'source.pdf')
        -> 's3://bucket/papers/10.1002%2F%28SICI%291098-1004%28200001%2915%3A1%3C121%3A%3AAID-HUMU37%3E3.0.CO%3B2-U/source.pdf'
    """
    return f'{_get_base()}/papers/{encode_doi(doi)}/{filename}'


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
