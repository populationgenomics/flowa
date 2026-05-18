"""Pipeline run management.

`RunManager` owns the in-memory map from `variant_id -> RunRecord`. Runs are
spawned via `asyncio.create_task(...)` and tracked there; the task reference
prevents premature garbage collection while flowa is still running. State
does not survive gateway restart — the demo's `concurrently` orchestration
kills all three processes together if any one exits, so partial-restart
isn't a real scenario worth designing for.

`POST /runs` returns immediately with the run id; the runner coroutine
writes its terminal state to `progress.jsonl` asynchronously. Callers
observe completion by polling the JSONL file (its last line is `run_done`
or `run_error`) — there is no awaitable handle exposed back through HTTP.
"""

import asyncio
import logging
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from fastapi import HTTPException, status
from flowa.progress import ProgressCallback, ProgressEvent, now_iso
from flowa.run import run_pipeline
from flowa.schema import VariantSpec
from flowa.settings import Settings as FlowaSettings

from .progress import ProgressSink

log = logging.getLogger(__name__)

RunStatus = Literal['running', 'success', 'error']

# Pipeline injection point. Tests pass a stub coroutine factory that emits a
# scripted event sequence and resolves quickly, so the real flowa pipeline
# never runs in unit tests. Keyword-only matches `run_pipeline`'s signature
# so swapping at the call site is invisible.
PipelineFn = Callable[..., Awaitable[None]]


@dataclass
class RunRecord:
    """Public state for one pipeline run."""

    run_id: str
    variant_id: str
    started_at: str  # ISO 8601 UTC, matches ProgressEvent.timestamp.
    status: RunStatus


class RunManager:
    """Tracks active runs and spawns pipeline coroutines.

    One instance per gateway process; held on `app.state.runs`. Tests
    construct their own instance with a stub `pipeline` callable.
    """

    def __init__(
        self,
        *,
        flowa_settings: FlowaSettings,
        data_dir: Path,
        max_concurrent_runs: int,
        pipeline: PipelineFn = run_pipeline,
    ) -> None:
        self._flowa_settings = flowa_settings
        self._data_dir = data_dir
        self._max_concurrent_runs = max_concurrent_runs
        self._pipeline = pipeline
        self._records: dict[str, RunRecord] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}

    @property
    def records(self) -> dict[str, RunRecord]:
        """Snapshot view of the run map. Tests use this to assert state."""
        return dict(self._records)

    def get_active(self, variant_id: str) -> RunRecord | None:
        """Most recent record for `variant_id`, or None. Status field tells
        the consumer whether it's still running."""
        return self._records.get(variant_id)

    async def wait(self, run_id: str) -> None:
        """Await a run's runner coroutine. No-op once it has terminated.

        Test-only convenience — production callers observe completion by
        polling `progress.jsonl`.
        """
        task = self._tasks.get(run_id)
        if task is not None:
            await task

    def start(self, *, variant_id: str, variant_spec: VariantSpec) -> RunRecord:
        """Kick off a pipeline run. Returns immediately.

        Raises HTTPException(409) if a run is already in flight for this
        variant; HTTPException(429) if the concurrency cap is hit.
        """
        existing = self._records.get(variant_id)
        if existing is not None and existing.status == 'running':
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f'run {existing.run_id} already in flight for variant {variant_id}',
            )

        running = sum(1 for r in self._records.values() if r.status == 'running')
        if running >= self._max_concurrent_runs:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=f'concurrent run cap reached ({running}/{self._max_concurrent_runs})',
            )

        run_id = uuid.uuid4().hex
        started_at = now_iso()
        record = RunRecord(run_id=run_id, variant_id=variant_id, started_at=started_at, status='running')

        # `progress.jsonl` lives under the assessment dir so the run is
        # discoverable by variant alone via a filesystem scan (no run-id
        # manifest needed). ProgressSink's `mkdir(parents=True)` creates
        # the full `assessments/<variant>/runs/<run>/` chain, so the run
        # dir exists even if the pipeline dies before any other artifact
        # is written.
        sink_path = self._data_dir / 'assessments' / variant_id / 'runs' / run_id / 'progress.jsonl'
        sink = ProgressSink(sink_path)

        self._records[variant_id] = record
        # Hold the task reference so the asyncio loop doesn't GC the
        # coroutine mid-flight; we drop it once the runner finishes.
        task = asyncio.create_task(
            self._runner(record=record, variant_spec=variant_spec, sink_append=sink.append),
            name=f'flowa-run-{run_id}',
        )
        self._tasks[run_id] = task

        item = variant_spec.variants[0]
        log.info('Started run %s for variant %s (%s:%s)', run_id, variant_id, item.transcript, item.hgvs_c)
        return record

    async def _runner(
        self,
        *,
        record: RunRecord,
        variant_spec: VariantSpec,
        sink_append: ProgressCallback,
    ) -> None:
        """Drive the pipeline; emit run_done / run_error around it."""
        # Mastermind requires a paid API token; LitVar is freely accessible.
        # Pick whichever the environment is configured for so the demo
        # works either way.
        source = 'mastermind' if self._flowa_settings.mastermind_api_token else 'litvar'
        try:
            await self._pipeline(
                self._flowa_settings,
                variant_id=record.variant_id,
                variant_spec=variant_spec,
                source=source,
                on_progress=sink_append,
            )
            sink_append(ProgressEvent(timestamp=now_iso(), stage='aggregate', kind='run_done', detail='ok'))
            record.status = 'success'
            log.info('Run %s complete (variant %s)', record.run_id, record.variant_id)
        except Exception as e:
            sink_append(ProgressEvent(timestamp=now_iso(), stage='aggregate', kind='run_error', error=str(e)))
            record.status = 'error'
            log.exception('Run %s failed (variant %s)', record.run_id, record.variant_id)
        finally:
            self._tasks.pop(record.run_id, None)


def make_run_manager(*, data_dir: Path, max_concurrent_runs: int) -> RunManager:
    """Factory used by the FastAPI lifespan. Constructs the flowa Settings
    here so any missing env var fails the gateway boot rather than the
    first /runs request."""
    return RunManager(
        flowa_settings=FlowaSettings(),  # type: ignore[call-arg]
        data_dir=data_dir,
        max_concurrent_runs=max_concurrent_runs,
    )
