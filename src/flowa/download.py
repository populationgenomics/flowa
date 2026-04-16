"""Download PDF from PMC for a single paper."""

import asyncio
import json
import logging
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


async def fetch_pmc_pdf(pmid: int, client: httpx.AsyncClient, email: str, tool: str) -> tuple[bytes | None, str]:
    """Attempt to fetch PDF from PMC for a given PMID.

    Returns:
        Tuple of (pdf_bytes or None, message)
    """
    # Step 1: Get PMCID from idconv API
    idconv_url = f'https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/?ids={pmid}&idtype=pmid&format=json&tool={tool}&email={email}'
    response = await client.get(idconv_url)
    response.raise_for_status()
    idconv_data = response.json()

    records = idconv_data.get('records', [])
    if not records or not records[0].get('pmcid'):
        return None, 'No PMCID found (not in PMC)'

    pmcid = records[0]['pmcid']
    log.debug('Found PMCID: %s', pmcid)

    # Step 2: Find latest version in S3 bucket
    s3 = _make_s3_client()
    version = await asyncio.to_thread(_resolve_latest_version, s3, pmcid)
    if version is None:
        return None, f'{pmcid} not in PMC OA bucket'

    # Step 3: Fetch per-article metadata JSON
    metadata_key = f'metadata/{pmcid}.{version}.json'
    log.debug('Fetching metadata: %s', metadata_key)
    metadata_bytes = await asyncio.to_thread(_download_s3_object, s3, metadata_key)
    metadata = json.loads(metadata_bytes)

    # Step 4: Identify main PDF and supplement PDFs
    pdf_url = metadata.get('pdf_url')
    if not pdf_url:
        return None, f'No pdf_url in metadata for {pmcid}.{version}'

    main_pdf_key = _s3_url_to_key(pdf_url)
    supplement_keys = [
        _s3_url_to_key(url) for url in metadata.get('media_urls', []) if url.lower().split('?')[0].endswith('.pdf')
    ]

    log.debug('Main PDF: %s, %d supplement PDFs', main_pdf_key, len(supplement_keys))

    # Step 5: Download all PDFs
    async def download(key: str) -> bytes:
        return await asyncio.to_thread(_download_s3_object, s3, key)

    all_keys = [main_pdf_key, *supplement_keys]
    all_contents = await asyncio.gather(*[download(key) for key in all_keys])

    # Step 6: Write to temp files, filter supplements, concatenate
    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir_path = Path(tmpdir)

        main_path = tmpdir_path / 'main.pdf'
        main_path.write_bytes(all_contents[0])

        supplement_paths: list[Path] = []
        for i, content in enumerate(all_contents[1:]):
            path = tmpdir_path / f'supplement_{i:03d}.pdf'
            path.write_bytes(content)
            supplement_paths.append(path)

        supplement_paths = _filter_supplements_by_page_count(supplement_paths)
        all_pdfs = [main_path, *supplement_paths]

        output_path = tmpdir_path / 'output.pdf'
        concatenate_pdfs(all_pdfs, output_path)
        result_bytes = output_path.read_bytes()

    message = f'Downloaded from PMC ({pmcid}.{version}) - {len(all_pdfs)} PDFs ({len(supplement_paths)} supplements)'
    return result_bytes, message


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
        pdf_bytes, message = await fetch_pmc_pdf(pmid, client, email, tool)

    if pdf_bytes is None:
        log.info('%s not available in PMC: %s', doi, message)
        return

    write_bytes(pdf_url, pdf_bytes)
    log.info('Downloaded %s: %s (%d bytes)', doi, message, len(pdf_bytes))


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
