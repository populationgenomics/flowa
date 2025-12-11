"""Convert PDF to Docling JSON."""

import logging
from io import BytesIO

import typer
from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.document_converter import DocumentConverter, PdfFormatOption
from docling_core.types.io import DocumentStream

from flowa.storage import exists, paper_url, read_bytes, write_json

log = logging.getLogger(__name__)


def convert_paper(
    pmid: int = typer.Option(..., '--pmid', help='PubMed ID to convert'),
) -> None:
    """Convert PDF to Docling JSON.

    Reads PDF from papers/{pmid}/source.pdf in object storage.
    Stores result to papers/{pmid}/docling.json.
    Exits with error if conversion fails.
    """
    pdf_url = paper_url(pmid, 'source.pdf')
    json_url = paper_url(pmid, 'docling.json')

    # Check if already converted
    if exists(json_url):
        log.info('Already converted: %s', json_url)
        return

    # Check PDF exists
    try:
        pdf_bytes = read_bytes(pdf_url)
    except FileNotFoundError:
        log.info('Skipping PMID %s: PDF not available', pmid)
        return

    log.info('Converting PMID %s (%d bytes)', pmid, len(pdf_bytes))

    pipeline_options = PdfPipelineOptions(do_ocr=False)
    converter = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options)})
    source = DocumentStream(name=f'{pmid}.pdf', stream=BytesIO(pdf_bytes))
    result = converter.convert(source, raises_on_error=True)

    write_json(json_url, result.document.export_to_dict())

    log.info('Converted PMID %s successfully', pmid)
