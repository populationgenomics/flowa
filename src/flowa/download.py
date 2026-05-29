"""Download PDF from PMC for a single paper."""

import asyncio
import json
import logging
import re
import tempfile
from pathlib import Path

import boto3
import httpx
import typer
from botocore import UNSIGNED
from botocore.config import Config
from botocore.exceptions import ClientError
from pypdf import PdfReader, PdfWriter
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


def concatenate_pdfs(pdf_paths: list[Path], output_path: Path) -> None:
    """Concatenate multiple PDFs into a single file."""
    writer = PdfWriter()

    for pdf_path in pdf_paths:
        writer.append(str(pdf_path))

    with open(output_path, 'wb') as output_file:
        writer.write(output_file)


def _filter_supplements_by_page_count(
    supplement_pdfs: list[Path],
    *,
    max_pages_per_supplement: int = 20,
    max_total_supplement_pages: int = 50,
) -> list[Path]:
    """Filter supplement PDFs by page count to avoid timeouts on huge table dumps."""
    accepted: list[Path] = []
    total_pages = 0

    for pdf_path in supplement_pdfs:
        try:
            pages = len(PdfReader(pdf_path).pages)
        except Exception as e:
            log.warning('Cannot read page count for %s, skipping: %s', pdf_path.name, e)
            continue

        if pages > max_pages_per_supplement:
            log.info('Skipping supplement %s: %d pages (limit %d)', pdf_path.name, pages, max_pages_per_supplement)
            continue

        if total_pages + pages > max_total_supplement_pages:
            log.info(
                'Skipping supplement %s: %d pages would exceed total budget (%d/%d)',
                pdf_path.name,
                pages,
                total_pages,
                max_total_supplement_pages,
            )
            continue

        accepted.append(pdf_path)
        total_pages += pages

    return accepted


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
    """Fetch a paper's source PDF and its xlsx/docx supplements from PMC.

    The main PDF plus any PDF supplements are concatenated into a single PDF.
    xlsx/xls/docx supplements are returned as raw ``(basename, bytes)`` pairs in
    PMC ``media_urls`` order for the caller to store; ``.doc`` (legacy OLE Word)
    and other media (images, etc.) are ignored.

    Returns:
        ``(pdf_bytes_or_None, supplements, message)``.
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
    pdf_supplement_keys = [_s3_url_to_key(u) for u in pdf_supplement_urls]
    office_keys = [_s3_url_to_key(u) for u in office_supplement_urls]

    log.debug(
        'Main PDF: %s, %d PDF supplements, %d xlsx/docx supplements',
        main_pdf_key,
        len(pdf_supplement_keys),
        len(office_keys),
    )

    async def download(key: str) -> bytes:
        return await asyncio.to_thread(_download_s3_object, s3, key)

    # Step 5: Download PDFs (main + PDF supplements) and the office supplements.
    pdf_keys = [main_pdf_key, *pdf_supplement_keys]
    pdf_contents = await asyncio.gather(*[download(key) for key in pdf_keys])
    office_contents = await asyncio.gather(*[download(key) for key in office_keys])

    # Step 6: Write PDFs to temp files, filter by page count, concatenate.
    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir_path = Path(tmpdir)

        main_path = tmpdir_path / 'main.pdf'
        main_path.write_bytes(pdf_contents[0])

        supplement_paths: list[Path] = []
        for i, content in enumerate(pdf_contents[1:]):
            path = tmpdir_path / f'supplement_{i:03d}.pdf'
            path.write_bytes(content)
            supplement_paths.append(path)

        supplement_paths = _filter_supplements_by_page_count(supplement_paths)
        all_pdfs = [main_path, *supplement_paths]

        output_path = tmpdir_path / 'output.pdf'
        concatenate_pdfs(all_pdfs, output_path)
        result_bytes = output_path.read_bytes()

    # Office supplements keep PMC media order; the caller assigns ord prefixes.
    supplements = [(key.rsplit('/', 1)[-1], data) for key, data in zip(office_keys, office_contents, strict=True)]

    message = (
        f'Downloaded from PMC ({pmcid}.{version}) - {len(all_pdfs)} PDFs '
        f'({len(supplement_paths)} PDF supplements), {len(supplements)} xlsx/docx supplements'
    )
    return result_bytes, supplements, message


async def download_paper_async(
    base: str,
    doi: str,
    email: str = 'flowa@populationgenomics.org.au',
    tool: str = 'flowa',
    timeout: float = 60.0,
) -> None:
    """Download PDF from PMC for a single paper."""
    pdf_url = paper_url(base, doi, 'source.pdf')

    if exists(pdf_url):
        log.info('PDF already exists: %s', doi)
        return

    metadata = read_json(paper_url(base, doi, 'metadata.json'))
    pmid = metadata.get('pmid')

    if not pmid:
        log.info('%s: no PMID in metadata, skipping PMC download', doi)
        return

    log.info('Downloading %s (PMID %s)', doi, pmid)

    async with httpx.AsyncClient(timeout=timeout) as client:
        pdf_bytes, supplements, message = await fetch_pmc_paper(pmid, client, email, tool)

    if pdf_bytes is None:
        log.info('%s not available in PMC: %s', doi, message)
        return

    write_bytes(pdf_url, pdf_bytes)
    # Store xlsx/docx supplements under papers/{doi}/supplements/. The ord
    # prefix freezes PMC media order so assemble has a deterministic sequence.
    for ord_i, (basename, data) in enumerate(supplements):
        safe = _sanitize_supplement_filename(basename)
        write_bytes(paper_url(base, doi, f'supplements/{ord_i:03d}_{safe}'), data)
    log.info('Downloaded %s: %s (%d bytes, %d supplements)', doi, message, len(pdf_bytes), len(supplements))


def download_paper(
    doi: str = typer.Option(..., '--doi', help='DOI of the paper'),
    email: str = typer.Option('flowa@populationgenomics.org.au', '--email', help='Email for NCBI API'),
    tool: str = typer.Option('flowa', '--tool', help='Tool name for NCBI API'),
    timeout: float = typer.Option(60.0, '--timeout', help='HTTP timeout in seconds'),
) -> None:
    """Download PDF from PMC for a single paper.

    Reads papers/{encoded_doi}/metadata.json (written by query step) to get the PMID
    for PMC lookup. Stores PDF to papers/{encoded_doi}/source.pdf.

    Skip logic:
    - PDF exists -> already have it (downloaded or manually added)
    - No metadata.json -> paper not resolved by query step
    - No PMID in metadata -> not a PubMed-indexed paper
    """
    s = Settings()  # type: ignore[call-arg]
    asyncio.run(download_paper_async(s.flowa_storage_base, doi, email, tool, timeout))
