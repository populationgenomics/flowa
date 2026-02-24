"""Download PDF from PMC for a single paper."""

import logging
import re
import tarfile
import tempfile
from pathlib import Path

import httpx
import typer
from defusedxml import ElementTree
from pypdf import PdfWriter
from tenacity import retry, stop_after_attempt, wait_exponential

from flowa.storage import exists, paper_url, read_json, write_bytes

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


@retry(stop=stop_after_attempt(3), wait=wait_exponential(), reraise=True)
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
    - PDF exists → already have it (downloaded or manually added)
    - No metadata.json → paper not resolved by query step
    - No PMID in metadata → not a PubMed-indexed paper (future: download preprints via DOI)
    """
    pdf_url = paper_url(doi, 'source.pdf')

    if exists(pdf_url):
        log.info('PDF already exists: %s', doi)
        return

    metadata = read_json(paper_url(doi, 'metadata.json'))
    pmid = metadata.get('pmid')

    if not pmid:
        log.info('%s: no PMID in metadata, skipping PMC download', doi)
        return

    log.info('Downloading %s (PMID %s)', doi, pmid)

    with httpx.Client(timeout=timeout) as client:
        pdf_bytes, message = fetch_pmc_pdf(pmid, client, email, tool)

    if pdf_bytes is None:
        log.info('%s not available in PMC: %s', doi, message)
        return

    write_bytes(pdf_url, pdf_bytes)
    log.info('Downloaded %s: %s (%d bytes)', doi, message, len(pdf_bytes))
