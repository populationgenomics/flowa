"""Download PDF from PMC for a single paper."""

import asyncio
import json
import logging
import re

import boto3
import httpx
import typer
from botocore import UNSIGNED
from botocore.config import Config
from botocore.exceptions import ClientError
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from flowa.http_retry import retry_transient_http
from flowa.settings import Settings
from flowa.storage import exists, paper_url, read_json, write_bytes

log = logging.getLogger(__name__)

PMC_OA_BUCKET = 'pmc-oa-opendata'
_S3_CONFIG = Config(signature_version=UNSIGNED, region_name='us-east-1')


def _make_s3_client():  # type: ignore[no-untyped-def]
    """Create an anonymous S3 client for the PMC OA bucket."""
    return boto3.client('s3', config=_S3_CONFIG)


def _resolve_latest_version(s3, pmcid: str) -> int | None:  # type: ignore[no-untyped-def]
    """Find the latest version number for a PMCID in the OA bucket.

    Returns the version number (e.g. 2) or None if the article is not in the bucket.
    """
    response = s3.list_objects_v2(Bucket=PMC_OA_BUCKET, Prefix=f'{pmcid}.', Delimiter='/')
    prefixes = response.get('CommonPrefixes', [])
    if not prefixes:
        return None

    # Prefixes look like "PMC12345.1/", "PMC12345.2/" — extract version numbers
    versions: list[int] = []
    for p in prefixes:
        prefix_str = p['Prefix'].rstrip('/')
        version_str = prefix_str.rsplit('.', 1)[-1]
        try:
            versions.append(int(version_str))
        except ValueError:
            continue

    return max(versions) if versions else None


@retry(
    stop=stop_after_attempt(5),
    wait=wait_exponential(),
    retry=retry_if_exception_type(ClientError),
    reraise=True,
    before_sleep=lambda rs: log.warning(
        'S3 download failed (%s), retrying (attempt %d/5)',
        rs.outcome.exception() if rs.outcome else 'unknown',
        rs.attempt_number,
    ),
)
def _download_s3_object(s3, key: str) -> bytes:  # type: ignore[no-untyped-def]
    """Download a single object from the PMC OA bucket with retries."""
    response = s3.get_object(Bucket=PMC_OA_BUCKET, Key=key)
    return response['Body'].read()


def _s3_url_to_key(s3_url: str) -> str:
    """Convert an S3 URL from metadata JSON to a plain key.

    Strips the 's3://bucket/' prefix and any '?md5=...' query parameter.
    Example: 's3://pmc-oa-opendata/PMC123.1/file.pdf?md5=abc' -> 'PMC123.1/file.pdf'
    """
    # Strip s3://bucket/ prefix
    path = s3_url.split(f's3://{PMC_OA_BUCKET}/')[-1]
    # Strip query params
    return path.split('?')[0]


def _partition_media_urls(media_urls: list[str]) -> tuple[list[str], list[str]]:
    """Split PMC ``media_urls`` into ``(pdf_urls, office_urls)`` by extension.

    ``office`` is xlsx/xls/docx — the supplement types markitdown converts. ``.doc``
    (legacy OLE Word, which markitdown's docx backend can't read) and all other
    media (images, etc.) are dropped: absent from both lists.
    """
    pdf_urls: list[str] = []
    office_urls: list[str] = []
    for url in media_urls:
        path = url.lower().split('?')[0]
        if path.endswith('.pdf'):
            pdf_urls.append(url)
        elif path.endswith(('.xlsx', '.xls', '.docx')):
            office_urls.append(url)
    return pdf_urls, office_urls


def _sanitize_supplement_filename(basename: str) -> str:
    """Sanitise a supplement basename for safe use in a storage path.

    PMC media basenames are ASCII-safe; user uploads vary. Collapses any
    character outside ``[A-Za-z0-9._-]`` to ``_`` and caps the length at 128.
    """
    return re.sub(r'[^A-Za-z0-9._-]', '_', basename)[:128]


@retry_transient_http
async def _fetch_pmcid(client: httpx.AsyncClient, pmid: int, email: str, tool: str) -> str | None:
    """Resolve PMID -> PMCID via NCBI idconv; None when no PMCID is registered."""
    url = (
        f'https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/'
        f'?ids={pmid}&idtype=pmid&format=json&tool={tool}&email={email}'
    )
    response = await client.get(url)
    response.raise_for_status()
    records = response.json().get('records', [])
    if not records:
        return None
    return records[0].get('pmcid')


async def fetch_pmc_paper(
    pmid: int, client: httpx.AsyncClient, email: str, tool: str
) -> tuple[bytes | None, list[tuple[str, bytes]], str]:
    """Fetch a paper's main PDF and its supplements (PDF + xlsx/docx) from PMC.

    The main article PDF is returned on its own — PDF supplements are no longer
    concatenated into it. Every supplement (PDF and office) is returned as a raw
    ``(basename, bytes)`` pair, PDF supplements first then office, each in PMC
    ``media_urls`` order, for the caller to store under ``supplements/``.
    ``flowa.convert`` later page-caps, transcribes, and merges the PDF supplements;
    ``flowa.assemble`` converts the office ones. ``.doc`` (legacy OLE Word) and
    other media (images, etc.) are ignored.

    Returns:
        ``(main_pdf_bytes_or_None, supplements, message)``.
    """
    # Step 1: Get PMCID from idconv API
    pmcid = await _fetch_pmcid(client, pmid, email, tool)
    if pmcid is None:
        return None, [], 'No PMCID found (not in PMC)'
    log.debug('Found PMCID: %s', pmcid)

    # Step 2: Find latest version in S3 bucket
    s3 = _make_s3_client()
    version = await asyncio.to_thread(_resolve_latest_version, s3, pmcid)
    if version is None:
        return None, [], f'{pmcid} not in PMC OA bucket'

    # Step 3: Fetch per-article metadata JSON
    metadata_key = f'metadata/{pmcid}.{version}.json'
    log.debug('Fetching metadata: %s', metadata_key)
    metadata_bytes = await asyncio.to_thread(_download_s3_object, s3, metadata_key)
    metadata = json.loads(metadata_bytes)

    # Step 4: Identify the main PDF, PDF supplements, and xlsx/docx supplements
    pdf_url = metadata.get('pdf_url')
    if not pdf_url:
        return None, [], f'No pdf_url in metadata for {pmcid}.{version}'

    main_pdf_key = _s3_url_to_key(pdf_url)
    pdf_supplement_urls, office_supplement_urls = _partition_media_urls(metadata.get('media_urls', []))
    supplement_keys = [_s3_url_to_key(u) for u in (*pdf_supplement_urls, *office_supplement_urls)]

    log.debug(
        'Main PDF: %s, %d PDF supplements, %d xlsx/docx supplements',
        main_pdf_key,
        len(pdf_supplement_urls),
        len(office_supplement_urls),
    )

    async def download(key: str) -> bytes:
        return await asyncio.to_thread(_download_s3_object, s3, key)

    # Step 5: Download the main PDF and every supplement (PDF + office) as raw bytes.
    main_bytes = await download(main_pdf_key)
    supplement_contents = await asyncio.gather(*[download(key) for key in supplement_keys])
    # PDF supplements first, then office — each in PMC media order. The caller
    # assigns ord prefixes; convert/assemble dispatch by extension.
    supplements = [
        (key.rsplit('/', 1)[-1], data) for key, data in zip(supplement_keys, supplement_contents, strict=True)
    ]

    message = (
        f'Downloaded from PMC ({pmcid}.{version}) - main PDF + '
        f'{len(pdf_supplement_urls)} PDF + {len(office_supplement_urls)} xlsx/docx supplements'
    )
    return main_bytes, supplements, message


async def download_paper_async(
    base: str,
    doi: str,
    email: str = 'flowa@populationgenomics.org.au',
    tool: str = 'flowa',
    timeout: float = 60.0,
) -> None:
    """Download the main PDF and supplements from PMC for a single paper."""
    main_pdf_url = paper_url(base, doi, 'main.pdf')

    if exists(main_pdf_url):
        log.info('Main PDF already exists: %s', doi)
        return

    metadata = read_json(paper_url(base, doi, 'metadata.json'))
    pmid = metadata.get('pmid')

    if not pmid:
        log.info('%s: no PMID in metadata, skipping PMC download', doi)
        return

    log.info('Downloading %s (PMID %s)', doi, pmid)

    async with httpx.AsyncClient(timeout=timeout) as client:
        main_bytes, supplements, message = await fetch_pmc_paper(pmid, client, email, tool)

    if main_bytes is None:
        log.info('%s not available in PMC: %s', doi, message)
        return

    write_bytes(main_pdf_url, main_bytes)
    # Store every supplement under papers/{doi}/supplements/. The ord prefix
    # freezes ingestion order; convert/assemble dispatch by extension (PDF
    # supplements are page-capped + merged in convert, office in assemble).
    for ord_i, (basename, data) in enumerate(supplements):
        safe = _sanitize_supplement_filename(basename)
        write_bytes(paper_url(base, doi, f'supplements/{ord_i:03d}_{safe}'), data)
    log.info('Downloaded %s: %s (%d bytes main, %d supplements)', doi, message, len(main_bytes), len(supplements))


def download_paper(
    doi: str = typer.Option(..., '--doi', help='DOI of the paper'),
    email: str = typer.Option('flowa@populationgenomics.org.au', '--email', help='Email for NCBI API'),
    tool: str = typer.Option('flowa', '--tool', help='Tool name for NCBI API'),
    timeout: float = typer.Option(60.0, '--timeout', help='HTTP timeout in seconds'),
) -> None:
    """Download the main PDF and supplements from PMC for a single paper.

    Reads papers/{encoded_doi}/metadata.json (written by query step) to get the PMID
    for PMC lookup. Stores the main PDF to papers/{encoded_doi}/main.pdf and each
    supplement to papers/{encoded_doi}/supplements/{ord}_{name}.

    Skip logic:
    - main.pdf exists -> already have it (downloaded or manually added)
    - No metadata.json -> paper not resolved by query step
    - No PMID in metadata -> not a PubMed-indexed paper
    """
    s = Settings()  # type: ignore[call-arg]
    asyncio.run(download_paper_async(s.flowa_storage_base, doi, email, tool, timeout))
