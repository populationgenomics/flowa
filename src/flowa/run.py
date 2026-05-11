"""Single-command pipeline orchestrator: query -> download -> convert -> extract -> aggregate."""

import asyncio
import logging
from collections.abc import Callable
from typing import Literal

import logfire
import typer

from flowa.aggregate import aggregate_evidence_async
from flowa.convert import convert_paper_async
from flowa.download import download_paper_async
from flowa.extract import extract_paper_async
from flowa.progress import ProgressCallback, ProgressEvent, Stage, emit, now_iso
from flowa.query import query_dois_async
from flowa.settings import ModelConfig, Settings

log = logging.getLogger(__name__)

DEFAULT_CONVERT_CONCURRENCY = 20
DEFAULT_EXTRACT_CONCURRENCY = 20
DEFAULT_DOWNLOAD_CONCURRENCY = 5


async def process_paper(
    base: str,
    variant_id: str,
    doi: str,
    convert_model: ModelConfig,
    extraction_model: ModelConfig,
    prompt_set: str,
    download_semaphore: asyncio.Semaphore,
    convert_semaphore: asyncio.Semaphore,
    extract_semaphore: asyncio.Semaphore,
    on_paper_done: Callable[[Stage, str], None] | None = None,
) -> None:
    """Download, convert, and extract a single paper.

    `on_paper_done(stage, doi)` fires after each sub-stage completes
    (stage in {"download", "convert", "extract"}), letting the caller
    surface per-stage progress.
    """
    with logfire.span('flowa.process_paper', doi=doi):
        async with download_semaphore:
            await download_paper_async(base, doi)
        if on_paper_done is not None:
            on_paper_done('download', doi)

        async with convert_semaphore:
            await convert_paper_async(base, doi, convert_model, prompt_set)
        if on_paper_done is not None:
            on_paper_done('convert', doi)

        async with extract_semaphore:
            await extract_paper_async(base, variant_id, doi, extraction_model, prompt_set)
        if on_paper_done is not None:
            on_paper_done('extract', doi)


async def run_pipeline(
    settings: Settings,
    variant_id: str,
    gene: str,
    hgvs_c: str,
    source: Literal['mastermind', 'litvar'] = 'mastermind',
    convert_concurrency: int = DEFAULT_CONVERT_CONCURRENCY,
    extract_concurrency: int = DEFAULT_EXTRACT_CONCURRENCY,
    download_concurrency: int = DEFAULT_DOWNLOAD_CONCURRENCY,
    on_progress: ProgressCallback | None = None,
) -> None:
    """Run the full assessment pipeline for a variant.

    Progress events are emitted at stage boundaries (`stage_started` /
    `stage_done` for `query` and `aggregate`) and per-paper sub-stage
    completion (`paper` events with stage in {download, convert, extract}).
    The download/convert/extract sub-stages are interleaved across papers,
    so they don't get stage_started/stage_done bookends — the per-stage
    `done`/`total` counters on the `paper` events tell the whole story.

    `run_done` / `run_error` are NOT emitted here — the consumer that
    decides what "the run" means (a demo gateway, a worker process)
    frames those.
    """
    with logfire.span('flowa.pipeline', variant_id=variant_id, gene=gene, source=source):
        base = settings.flowa_storage_base
        download_semaphore = asyncio.Semaphore(download_concurrency)
        convert_semaphore = asyncio.Semaphore(convert_concurrency)
        extract_semaphore = asyncio.Semaphore(extract_concurrency)

        # 1. Query literature sources
        log.info('=== Query (%s) ===', source)
        emit(on_progress, ProgressEvent(timestamp=now_iso(), stage='query', kind='stage_started', detail=source))
        dois = await query_dois_async(base, variant_id, gene, hgvs_c, source, settings.mastermind_api_token)
        log.info('Query complete: %d papers found', len(dois))
        emit(
            on_progress,
            ProgressEvent(
                timestamp=now_iso(),
                stage='query',
                kind='stage_done',
                done=len(dois),
                total=len(dois),
                detail=f'{len(dois)} papers',
            ),
        )

        if not dois:
            log.warning('No papers found — running aggregation with ClinVar only')

        # 2. Process papers in parallel (download -> convert -> extract).
        log.info(
            '=== Processing %d papers (max concurrent: %d downloads, %d converts, %d extracts) ===',
            len(dois),
            download_concurrency,
            convert_concurrency,
            extract_concurrency,
        )
        completed = 0
        failed = 0
        # Per-substage counters. asyncio's cooperative scheduling makes plain
        # int increments race-free — each await is the only suspension point.
        substage_done: dict[Stage, int] = {'download': 0, 'convert': 0, 'extract': 0}
        total = len(dois)

        def on_paper_done(stage: Stage, doi: str) -> None:
            substage_done[stage] += 1
            emit(
                on_progress,
                ProgressEvent(
                    timestamp=now_iso(),
                    stage=stage,
                    kind='paper',
                    paper_id=doi,
                    done=substage_done[stage],
                    total=total,
                ),
            )

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
                    on_paper_done=on_paper_done,
                )
                completed += 1
            except Exception as e:
                log.exception('Failed to process paper %s — skipping', doi)
                failed += 1
                emit(
                    on_progress,
                    ProgressEvent(
                        timestamp=now_iso(),
                        stage='extract',
                        kind='paper',
                        paper_id=doi,
                        done=substage_done['extract'],
                        total=total,
                        detail='failed',
                        error=str(e),
                    ),
                )
            log.info('Progress: %d/%d done (%d failed)', completed + failed, len(dois), failed)

        async with asyncio.TaskGroup() as tg:
            for doi in dois:
                tg.create_task(process_and_track(doi))

        log.info('Processing complete: %d succeeded, %d failed out of %d', completed, failed, len(dois))

        # 3. Aggregate
        log.info('=== Aggregating ===')
        emit(on_progress, ProgressEvent(timestamp=now_iso(), stage='aggregate', kind='stage_started'))
        await aggregate_evidence_async(
            base, variant_id, settings.flowa_extraction_model, settings.ncbi_api_key, settings.flowa_prompt_set
        )
        emit(on_progress, ProgressEvent(timestamp=now_iso(), stage='aggregate', kind='stage_done'))

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
