"""Download PDFs from PMC for variant literature."""

import json
import logging
import re
import tarfile
import tempfile
from pathlib import Path

import requests
import typer
from defusedxml import ElementTree
from pypdf import PdfWriter
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from flowa.db import get_variant

logger = logging.getLogger(__name__)


def extract_supplements_from_nxml(nxml_path: Path, archive_dir: Path) -> list[Path]:
    """Parse NXML file and extract ordered list of PDF supplement paths.

    Args:
        nxml_path: Path to the .nxml file
        archive_dir: Directory containing extracted archive files

    Returns:
        List of paths to PDF supplements in order from NXML
    """
    supplements = []

    try:
        tree = ElementTree.parse(nxml_path)
        root = tree.getroot()
        if root is None:
            return []

        # Find all supplementary-material elements (in document order)
        for supp in root.iter():
            if supp.tag.endswith('supplementary-material'):
                # Find media element with href
                for media in supp.iter():
                    if media.tag.endswith('media'):
                        href = None
                        # Check xlink:href attribute (with or without namespace)
                        for attr_name, attr_value in media.attrib.items():
                            if 'href' in attr_name:
                                href = attr_value
                                break

                        if href and href.lower().endswith('.pdf'):
                            # Look for this file in the archive
                            matching_files = list(archive_dir.rglob(href))
                            if matching_files:
                                supplements.append(matching_files[0])
                                logger.debug(f'Found supplement PDF: {href}')

    except (ElementTree.ParseError, OSError) as e:
        logger.warning(f'Failed to parse NXML for supplements: {e}')

    return supplements


def concatenate_pdfs(pdf_paths: list[Path], output_path: Path) -> None:
    """Concatenate multiple PDFs into a single file.

    Args:
        pdf_paths: List of PDF paths to concatenate (in order)
        output_path: Path to write the concatenated PDF
    """
    writer = PdfWriter()

    for pdf_path in pdf_paths:
        writer.append(str(pdf_path))

    with open(output_path, 'wb') as output_file:
        writer.write(output_file)


def process_tgz_archive(tgz_content: bytes, output_path: Path) -> tuple[bool, str]:
    """Extract TGZ archive, find main PDF, concatenate with supplements.

    Args:
        tgz_content: Raw bytes of the TGZ archive
        output_path: Path to write the final concatenated PDF

    Returns:
        Tuple of (success, message)
    """
    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir_path = Path(tmpdir)
        tgz_path = tmpdir_path / 'archive.tar.gz'
        tgz_path.write_bytes(tgz_content)

        # Extract archive
        try:
            with tarfile.open(tgz_path, 'r:gz') as tar:
                tar.extractall(tmpdir_path, filter='data')
        except (tarfile.TarError, OSError) as e:
            return False, f'Failed to extract TGZ: {e}'

        # Find .nxml files
        nxml_files = list(tmpdir_path.rglob('*.nxml'))

        if len(nxml_files) == 0:
            return False, 'No NXML file found in archive'
        if len(nxml_files) > 1:
            return False, f'Multiple NXML files found: {[f.name for f in nxml_files]}'

        nxml_file = nxml_files[0]
        main_pdf = nxml_file.with_suffix('.pdf')

        if not main_pdf.exists():
            return False, f'Main PDF not found (expected {main_pdf.name})'

        # Parse NXML for supplements
        supplement_pdfs = extract_supplements_from_nxml(nxml_file, tmpdir_path)

        # Concatenate: main PDF + supplements
        all_pdfs = [main_pdf, *supplement_pdfs]

        try:
            concatenate_pdfs(all_pdfs, output_path)
            return (
                True,
                f'Concatenated {len(all_pdfs)} PDFs ({len(supplement_pdfs)} supplements)',
            )
        except OSError as e:
            return False, f'Failed to concatenate PDFs: {e}'


def fetch_pmc_pdf(
    pmid: int,
    output_path: Path,
    session: requests.Session,
    timeout: float,
    email: str,
    tool: str,
) -> tuple[bool, str]:
    """Attempt to fetch PDF from PMC for a given PMID.

    Args:
        pmid: PubMed ID
        output_path: Path to save the PDF
        session: requests Session with retry configuration
        timeout: HTTP timeout in seconds
        email: Email for NCBI API
        tool: Tool name for NCBI API

    Returns:
        Tuple of (success, message)
    """
    try:
        # Step 1: Get PMCID from idconv API
        idconv_url = f'https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/?ids={pmid}&idtype=pmid&format=json&tool={tool}&email={email}'
        response = session.get(idconv_url, timeout=timeout)
        response.raise_for_status()
        idconv_data = response.json()

        # Extract PMCID
        records = idconv_data.get('records', [])
        if not records or not records[0].get('pmcid'):
            return False, 'No PMCID found'

        pmcid = records[0]['pmcid']

        # Step 2: Get PDF link from OA API
        oa_url = f'https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id={pmcid}'
        response = session.get(oa_url, timeout=timeout)
        response.raise_for_status()
        oa_data = response.text

        # Step 3: Look for TGZ link (includes main article + supplements)
        tgz_match = re.search(
            r'<link[^>]*format="tgz"[^>]*href="([^"]+)"[^>]*/>',
            oa_data,
        )

        if not tgz_match:
            return False, f'No TGZ link in OA for {pmcid}'

        tgz_url = tgz_match.group(1)

        # Replace ftp:// with https:// if needed
        if tgz_url.startswith('ftp://'):
            tgz_url = tgz_url.replace('ftp://', 'https://')

        # Download TGZ
        tgz_response = session.get(tgz_url, timeout=timeout)
        tgz_response.raise_for_status()

        # Process TGZ: extract, find main PDF, concatenate with supplements
        success, message = process_tgz_archive(tgz_response.content, output_path)

        if success:
            return True, f'Downloaded from PMC ({pmcid}) - {message}'
        return False, f'TGZ processing failed for {pmcid}: {message}'

    except (requests.RequestException, OSError) as e:
        return False, f'Error: {e}'


def download_pdfs(
    variant_id: str = typer.Option(..., '--id', help='Variant identifier'),
    timeout: float = typer.Option(30.0, '--timeout', help='HTTP request timeout in seconds'),
    email: str = typer.Option('flowa@populationgenomics.org.au', '--email', help='Email for NCBI API identification'),
    tool: str = typer.Option('flowa', '--tool', help='Tool name for NCBI API identification'),
) -> None:
    """Download PMC PDFs for the specified variant.

    Fetches PDFs from PMC and saves them to data/papers/{pmid}.pdf (shared cache).
    Skips PMIDs that already have PDFs.

    Example: flowa download --id GAA_variant
    """
    # Get variant from database
    variant = get_variant(variant_id)
    if not variant:
        typer.echo(f'Error: Variant not found: {variant_id}', err=True)
        raise typer.Exit(1)

    # Parse PMID list
    pmids_json = variant.get('pmids')
    if not pmids_json:
        typer.echo(f'Error: No PMIDs found for variant {variant_id}', err=True)
        raise typer.Exit(1)

    try:
        pmids = json.loads(pmids_json)
    except json.JSONDecodeError as e:
        typer.echo(f'Error parsing PMIDs for {variant_id}: {e}', err=True)
        raise typer.Exit(1) from e

    if not pmids:
        typer.echo(f'Error: Empty PMID list for variant {variant_id}', err=True)
        raise typer.Exit(1)

    # Create papers directory (shared cache)
    papers_dir = Path('data/papers')
    papers_dir.mkdir(parents=True, exist_ok=True)

    typer.echo(f'Processing {variant_id} ({len(pmids)} PMIDs)...', err=True)

    # Configure requests session with retries
    session = requests.Session()
    retry_strategy = Retry(
        total=5,
        backoff_factor=1,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=['GET'],
    )
    adapter = HTTPAdapter(max_retries=retry_strategy)
    session.mount('http://', adapter)
    session.mount('https://', adapter)

    # Track statistics
    skipped_existing = 0
    downloaded = 0
    failed = 0
    failed_pmids = []

    for pmid in pmids:
        pdf_path = papers_dir / f'{pmid}.pdf'

        # Skip if file already exists
        if pdf_path.exists():
            logger.info(f'  Skipping PMID {pmid} (already exists)')
            skipped_existing += 1
            continue

        # Attempt to fetch from PMC
        success, message = fetch_pmc_pdf(pmid, pdf_path, session, timeout, email, tool)

        if success:
            logger.info(f'  ✅ PMID {pmid}: {message}')
            downloaded += 1
        else:
            logger.info(f'  ❌ PMID {pmid}: {message}')
            failed += 1
            failed_pmids.append(pmid)

    # Print summary
    typer.echo('\n' + '=' * 60, err=True)
    typer.echo(f'Total PMIDs: {len(pmids)}', err=True)
    typer.echo(f'  ✅ Downloaded from PMC: {downloaded}', err=True)
    typer.echo(f'  📁 Skipped (already exist): {skipped_existing}', err=True)
    typer.echo(f'  ❌ Failed to fetch: {failed}', err=True)
    typer.echo('=' * 60, err=True)

    # Print missing PDFs
    if failed_pmids:
        typer.echo(f'\nMissing PDFs for {variant_id}:\n')
        for pmid in failed_pmids:
            url = f'https://pubmed.ncbi.nlm.nih.gov/{pmid}'
            typer.echo(f'- {pmid}: {url}')
        typer.echo()
    else:
        typer.echo('\n✅ All PDFs successfully fetched!')
