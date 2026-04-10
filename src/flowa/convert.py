"""Convert PDF to Markdown via groundmark."""

import asyncio
import json
import logging
import time

import typer
from groundmark.convert import Config, convert

from flowa.settings import Settings
from flowa.storage import exists, paper_url, read_bytes, write_bytes, write_text

log = logging.getLogger(__name__)

PAGES_PER_CHUNK = 10


async def convert_paper_async(base: str, doi: str, model: str) -> None:
    """Convert a single paper's PDF to Markdown.

    Reads PDF from papers/{encoded_doi}/source.pdf in object storage.
    Stores result to papers/{encoded_doi}/markdown.md.
    """
    md_url = paper_url(base, doi, 'markdown.md')

    if exists(md_url):
        log.info('Already converted: %s', md_url)
        return

    pdf_url = paper_url(base, doi, 'source.pdf')
    try:
        pdf_bytes = read_bytes(pdf_url)
    except FileNotFoundError:
        log.info('Skipping DOI %s: PDF not available', doi)
        return

    log.info('Converting DOI %s (%d bytes, model: %s, chunk: %d pages)', doi, len(pdf_bytes), model, PAGES_PER_CHUNK)

    config = Config(model=model, page_count=PAGES_PER_CHUNK)
    t0 = time.monotonic()
    result = await convert(pdf_bytes, config)
    elapsed = time.monotonic() - t0

    write_text(md_url, result.markdown)

    raw_url = paper_url(base, doi, 'convert_raw.json')
    write_bytes(raw_url, json.dumps(result.all_messages).encode())

    log.info('Converted DOI %s: %d chars in %.1fs', doi, len(result.markdown), elapsed)


def convert_paper(
    doi: str = typer.Option(..., '--doi', help='DOI of the paper'),
) -> None:
    """Convert PDF to Markdown.

    Reads PDF from papers/{encoded_doi}/source.pdf in object storage.
    Stores result to papers/{encoded_doi}/markdown.md.
    """
    s = Settings()  # type: ignore[call-arg]
    asyncio.run(convert_paper_async(s.flowa_storage_base, doi, s.flowa_convert_model))
