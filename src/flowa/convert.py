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
    doi: str = typer.Option(..., '--doi', help='DOI of the paper'),
) -> None:
    """Convert PDF to Docling JSON.

    Reads PDF from papers/{doi_slug}/source.pdf in object storage.
    Stores result to papers/{doi_slug}/docling.json.
    Exits with error if conversion fails.
    """
    pdf_url = paper_url(doi, 'source.pdf')
    json_url = paper_url(doi, 'docling.json')

    # Check if already converted
    if exists(json_url):
        log.info('Already converted: %s', json_url)
        return

    # Check PDF exists
    try:
        pdf_bytes = read_bytes(pdf_url)
    except FileNotFoundError:
        log.info('Skipping DOI %s: PDF not available', doi)
        return

    log.info('Converting DOI %s (%d bytes)', doi, len(pdf_bytes))

    pipeline_options = PdfPipelineOptions(do_ocr=False)
    converter = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options)})
    source = DocumentStream(name=f'{doi}.pdf', stream=BytesIO(pdf_bytes))
    result = converter.convert(source, raises_on_error=True)

    write_json(json_url, result.document.export_to_dict())

    log.info('Converted DOI %s successfully', doi)
