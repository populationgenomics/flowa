"""Download PDF from PMC for a single paper."""

import logging
import re
import tarfile
import tempfile
import time
from pathlib import Path
from typing import Any

import httpx
import typer
from defusedxml import ElementTree
from metapub import PubMedFetcher  # type: ignore[import-untyped]
from metapub.ncbi_errors import NCBIServiceError  # type: ignore[import-untyped]
from pypdf import PdfWriter

from flowa.schema import METADATA_SCHEMA_VERSION, with_schema_version
from flowa.storage import exists, paper_url, write_bytes, write_json

log = logging.getLogger(__name__)


def extract_supplements_from_nxml(nxml_path: Path, archive_dir: Path) -> list[Path]:
    """Parse NXML file and extract ordered list of PDF supplement paths."""
    supplements = []

    try:
        tree = ElementTree.parse(nxml_path)
        root = tree.getroot()
        if root is None:
            return []

        for supp in root.iter():
            if supp.tag.endswith('supplementary-material'):
                for media in supp.iter():
                    if media.tag.endswith('media'):
                        href = None
                        for attr_name, attr_value in media.attrib.items():
                            if 'href' in attr_name:
                                href = attr_value
                                break

                        if href and href.lower().endswith('.pdf'):
                            matching_files = list(archive_dir.rglob(href))
                            if matching_files:
                                supplements.append(matching_files[0])
                                log.debug('Found supplement PDF: %s', href)

    except (ElementTree.ParseError, OSError) as e:
        log.warning('Failed to parse NXML for supplements: %s', e)

    return supplements


def concatenate_pdfs(pdf_paths: list[Path], output_path: Path) -> None:
    """Concatenate multiple PDFs into a single file."""
    writer = PdfWriter()

    for pdf_path in pdf_paths:
        writer.append(str(pdf_path))

    with open(output_path, 'wb') as output_file:
        writer.write(output_file)


def process_tgz_archive(tgz_content: bytes, output_path: Path) -> tuple[bool, str]:
    """Extract TGZ archive, find main PDF, concatenate with supplements."""
    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir_path = Path(tmpdir)
        tgz_path = tmpdir_path / 'archive.tar.gz'
        tgz_path.write_bytes(tgz_content)

        try:
            with tarfile.open(tgz_path, 'r:gz') as tar:
                tar.extractall(tmpdir_path, filter='data')
        except (tarfile.TarError, OSError) as e:
            return False, f'Failed to extract TGZ: {e}'

        nxml_files = list(tmpdir_path.rglob('*.nxml'))

        if len(nxml_files) == 0:
            return False, 'No NXML file found in archive'
        if len(nxml_files) > 1:
            return False, f'Multiple NXML files found: {[f.name for f in nxml_files]}'

        nxml_file = nxml_files[0]
        main_pdf = nxml_file.with_suffix('.pdf')

        if not main_pdf.exists():
            return False, f'Main PDF not found (expected {main_pdf.name})'

        supplement_pdfs = extract_supplements_from_nxml(nxml_file, tmpdir_path)
        all_pdfs = [main_pdf, *supplement_pdfs]

        try:
            concatenate_pdfs(all_pdfs, output_path)
            return True, f'Concatenated {len(all_pdfs)} PDFs ({len(supplement_pdfs)} supplements)'
        except OSError as e:
            return False, f'Failed to concatenate PDFs: {e}'


def fetch_pmc_pdf(pmid: int, client: httpx.Client, email: str, tool: str) -> tuple[bytes | None, str]:
    """Attempt to fetch PDF from PMC for a given PMID.

    Returns:
        Tuple of (pdf_bytes or None, message)
    """
    try:
        # Step 1: Get PMCID from idconv API
        idconv_url = f'https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/?ids={pmid}&idtype=pmid&format=json&tool={tool}&email={email}'
        response = client.get(idconv_url)
        response.raise_for_status()
        idconv_data = response.json()

        records = idconv_data.get('records', [])
        if not records or not records[0].get('pmcid'):
            return None, 'No PMCID found (not in PMC)'

        pmcid = records[0]['pmcid']
        log.debug('Found PMCID: %s', pmcid)

        # Step 2: Get PDF link from OA API
        oa_url = f'https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id={pmcid}'
        response = client.get(oa_url)
        response.raise_for_status()
        oa_data = response.text

        # Step 3: Look for TGZ link (includes main article + supplements)
        tgz_match = re.search(r'<link[^>]*format="tgz"[^>]*href="([^"]+)"[^>]*/>', oa_data)

        if not tgz_match:
            return None, f'No TGZ link in OA for {pmcid}'

        tgz_url = tgz_match.group(1)
        if tgz_url.startswith('ftp://'):
            tgz_url = tgz_url.replace('ftp://', 'https://')

        log.debug('Downloading TGZ from %s', tgz_url)
        tgz_response = client.get(tgz_url)
        tgz_response.raise_for_status()

        # Process TGZ to local temp file first
        with tempfile.NamedTemporaryFile(suffix='.pdf', delete=False) as tmp:
            tmp_path = Path(tmp.name)

        try:
            success, message = process_tgz_archive(tgz_response.content, tmp_path)
            if success:
                pdf_bytes = tmp_path.read_bytes()
                return pdf_bytes, f'Downloaded from PMC ({pmcid}) - {message}'
            return None, f'TGZ processing failed for {pmcid}: {message}'
        finally:
            tmp_path.unlink(missing_ok=True)

    except httpx.HTTPError as e:
        return None, f'HTTP error: {e}'


def fetch_pubmed_metadata(pmid: int, fetcher: PubMedFetcher, max_retries: int = 5) -> dict[str, Any]:
    """Fetch metadata for a paper from PubMed with retry on rate limit."""
    log.info('Fetching PubMed metadata for PMID %s', pmid)

    for attempt in range(max_retries):
        try:
            article = fetcher.article_by_pmid(pmid)
            return {
                'pmid': pmid,
                'title': article.title,
                'authors': article.authors or [],
                'date': article.history['entrez'].date().isoformat(),
                'journal': article.journal,
                'abstract': article.abstract,
            }
        except NCBIServiceError as e:
            if attempt == max_retries - 1:
                raise
            wait = 2**attempt  # 1, 2, 4, 8, 16 seconds
            log.warning('NCBI rate limit (attempt %d/%d), retrying in %ds: %s', attempt + 1, max_retries, wait, e)
            time.sleep(wait)

    raise RuntimeError('Unreachable')


def download_paper(
    pmid: int = typer.Option(..., '--pmid', help='PubMed ID to download'),
    email: str = typer.Option('flowa@populationgenomics.org.au', '--email', help='Email for NCBI API'),
    tool: str = typer.Option('flowa', '--tool', help='Tool name for NCBI API'),
    timeout: float = typer.Option(60.0, '--timeout', help='HTTP timeout in seconds'),
) -> None:
    """Download PDF from PMC for a single paper.

    Stores to object storage at papers/{pmid}/source.pdf and papers/{pmid}/metadata.json.

    Skip logic:
    - PDF exists → already have it (downloaded or manually added)
    - metadata.json exists but no PDF → previously tried and failed (not in PMC)

    To manually add a paper: just upload the PDF to papers/{pmid}/source.pdf.
    """
    pdf_url = paper_url(pmid, 'source.pdf')
    metadata_url = paper_url(pmid, 'metadata.json')

    if exists(pdf_url):
        log.info('PDF already exists: %s', pmid)
        return

    if exists(metadata_url):
        log.info('Skipping PMID %s: previously tried, not available in PMC', pmid)
        return

    log.info('Processing PMID %s', pmid)

    # Fetch PubMed metadata first (always useful to have)
    fetcher = PubMedFetcher()
    metadata = fetch_pubmed_metadata(pmid, fetcher)

    # Try to download PDF from PMC
    transport = httpx.HTTPTransport(retries=3)
    with httpx.Client(timeout=timeout, transport=transport) as client:
        pdf_bytes, message = fetch_pmc_pdf(pmid, client, email, tool)

    if pdf_bytes is None:
        # Store metadata to mark as "tried" - absence of PDF means unavailable
        write_json(metadata_url, with_schema_version(metadata, METADATA_SCHEMA_VERSION))
        log.info('PMID %s not available in PMC: %s', pmid, message)
        return

    # Store PDF and metadata
    write_bytes(pdf_url, pdf_bytes)
    write_json(metadata_url, with_schema_version(metadata, METADATA_SCHEMA_VERSION))

    log.info('Downloaded PMID %s: %s (%d bytes)', pmid, message, len(pdf_bytes))


# Keep old function name for backwards compatibility during transition
download_pdfs = download_paper
