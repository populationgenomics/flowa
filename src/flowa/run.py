"""Single-command pipeline orchestrator: query -> download -> convert -> extract -> aggregate."""

import asyncio
import logging
from typing import Literal

import logfire
import typer

from flowa.aggregate import aggregate_evidence_async
from flowa.convert import convert_paper_async
from flowa.download import download_paper_async
from flowa.extract import extract_paper_async
from flowa.query import query_dois_async
from flowa.settings import Settings

log = logging.getLogger(__name__)

DEFAULT_CONVERT_CONCURRENCY = 20
DEFAULT_EXTRACT_CONCURRENCY = 20
DEFAULT_DOWNLOAD_CONCURRENCY = 5


async def process_paper(
    base: str,
    variant_id: str,
    doi: str,
    convert_model: str,
    extraction_model: str,
    prompt_set: str,
    download_semaphore: asyncio.Semaphore,
    convert_semaphore: asyncio.Semaphore,
    extract_semaphore: asyncio.Semaphore,
) -> None:
    """Download, convert, and extract a single paper."""
    with logfire.span('flowa.process_paper', doi=doi):
        async with download_semaphore:
            await download_paper_async(base, doi)

        async with convert_semaphore:
            await convert_paper_async(base, doi, convert_model)

        async with extract_semaphore:
            await extract_paper_async(base, variant_id, doi, extraction_model, prompt_set)


async def run_pipeline(
    settings: Settings,
    variant_id: str,
    gene: str,
    hgvs_c: str,
    source: Literal['mastermind', 'litvar'] = 'mastermind',
    convert_concurrency: int = DEFAULT_CONVERT_CONCURRENCY,
    extract_concurrency: int = DEFAULT_EXTRACT_CONCURRENCY,
    download_concurrency: int = DEFAULT_DOWNLOAD_CONCURRENCY,
) -> None:
    """Run the full assessment pipeline for a variant."""
    with logfire.span('flowa.pipeline', variant_id=variant_id, gene=gene, source=source):
        base = settings.flowa_storage_base
        download_semaphore = asyncio.Semaphore(download_concurrency)
        convert_semaphore = asyncio.Semaphore(convert_concurrency)
        extract_semaphore = asyncio.Semaphore(extract_concurrency)

        # 1. Query literature sources
        log.info('=== Query (%s) ===', source)
        dois = await query_dois_async(base, variant_id, gene, hgvs_c, source, settings.mastermind_api_token)
        log.info('Query complete: %d papers found', len(dois))

        if not dois:
            log.warning('No papers found — running aggregation with ClinVar only')

        # 2. Process papers in parallel (download -> convert -> extract)
        log.info(
            '=== Processing %d papers (max concurrent: %d downloads, %d converts, %d extracts) ===',
            len(dois),
            download_concurrency,
            convert_concurrency,
            extract_concurrency,
        )
        completed = 0
        failed = 0

        async def process_and_track(doi: str) -> None:
            nonlocal completed, failed
            try:
                await process_paper(
                    base,
                    variant_id,
                    doi,
                    settings.flowa_convert_model,
                    settings.flowa_extraction_model,
                    settings.flowa_prompt_set,
                    download_semaphore,
                    convert_semaphore,
                    extract_semaphore,
                )
                completed += 1
            except Exception:
                log.exception('Failed to process paper %s — skipping', doi)
                failed += 1
            log.info('Progress: %d/%d done (%d failed)', completed + failed, len(dois), failed)

        async with asyncio.TaskGroup() as tg:
            for doi in dois:
                tg.create_task(process_and_track(doi))

        log.info('Processing complete: %d succeeded, %d failed out of %d', completed, failed, len(dois))

        # 3. Aggregate
        log.info('=== Aggregating ===')
        await aggregate_evidence_async(
            base, variant_id, settings.flowa_extraction_model, settings.ncbi_api_key, settings.flowa_prompt_set
        )

        log.info('=== Pipeline complete for %s ===', variant_id)


def run(
    variant_id: str = typer.Option(..., '--variant-id', help='Variant identifier'),
    gene: str = typer.Option(..., '--gene', '-g', help='Gene symbol (e.g., GAA)'),
    hgvs_c: str = typer.Option(..., '--hgvs-c', '-v', help='HGVS c. notation (e.g., c.2238G>C)'),
    source: Literal['mastermind', 'litvar'] = typer.Option('mastermind', '--source', '-s', help='Literature source'),
    convert_concurrency: int = typer.Option(
        DEFAULT_CONVERT_CONCURRENCY, '--convert-concurrency', help='Max concurrent PDF-to-Markdown conversions'
    ),
    extract_concurrency: int = typer.Option(
        DEFAULT_EXTRACT_CONCURRENCY, '--extract-concurrency', help='Max concurrent LLM extractions'
    ),
) -> None:
    """Run the full assessment pipeline: query -> download -> convert -> extract -> aggregate."""
    s = Settings()  # type: ignore[call-arg]
    asyncio.run(run_pipeline(s, variant_id, gene, hgvs_c, source, convert_concurrency, extract_concurrency))
