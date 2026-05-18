"""RunManager lifecycle: spawn, terminal-state transitions, conflict + cap.

Direct-method tests against the manager (rather than via HTTP) so they
exercise the asyncio task graph without TestClient's request/response
machinery in the way.
"""

import asyncio
import json
from collections.abc import Awaitable, Callable
from pathlib import Path

import pytest
from fastapi import HTTPException
from flowa.progress import ProgressCallback, ProgressEvent, now_iso
from flowa.schema import HgvsCVariant, VariantSpec

from demo_gateway.runs import RunManager

from .conftest import make_flowa_settings

StubPipeline = Callable[..., Awaitable[None]]


def _spec(transcript: str = 'NM_000001.1', hgvs_c: str = 'c.1A>T') -> VariantSpec:
    return VariantSpec(variants=[HgvsCVariant(kind='hgvs_c', transcript=transcript, hgvs_c=hgvs_c)])


def _make_manager(
    tmp_path: Path,
    *,
    pipeline: StubPipeline,
    max_concurrent_runs: int = 3,
) -> RunManager:
    return RunManager(
        flowa_settings=make_flowa_settings(tmp_path),
        data_dir=tmp_path,
        max_concurrent_runs=max_concurrent_runs,
        pipeline=pipeline,
    )


async def _no_op(*_args: object, **_kwargs: object) -> None:
    return None


async def test_start_returns_record_with_running_status(tmp_path: Path) -> None:
    manager = _make_manager(tmp_path, pipeline=_no_op)
    record = manager.start(variant_id='F508del', variant_spec=_spec('NM_000492.4', 'c.1521_1523del'))

    assert record.variant_id == 'F508del'
    assert record.status == 'running'
    assert record.run_id  # non-empty


async def test_start_creates_assessment_run_dir_before_pipeline_emits(tmp_path: Path) -> None:
    """The literature page polls progress as soon as the variant page mounts.
    The run dir must exist by the time `start` returns, even if the pipeline
    hasn't emitted its first event yet."""
    started_at_least_once = asyncio.Event()
    never_returns = asyncio.Event()

    async def hangs(*_args: object, **_kwargs: object) -> None:
        started_at_least_once.set()
        await never_returns.wait()

    manager = _make_manager(tmp_path, pipeline=hangs)
    record = manager.start(variant_id='hold', variant_spec=_spec())

    run_dir = tmp_path / 'assessments' / 'hold' / 'runs' / record.run_id
    assert run_dir.is_dir()

    # Allow the hanging coroutine to terminate so the event-loop closes cleanly.
    never_returns.set()
    await manager.wait(record.run_id)


async def test_run_transitions_to_success_on_clean_pipeline_completion(tmp_path: Path) -> None:
    manager = _make_manager(tmp_path, pipeline=_no_op)
    record = manager.start(variant_id='V1', variant_spec=_spec())
    await manager.wait(record.run_id)

    assert manager.get_active('V1').status == 'success'  # type: ignore[union-attr]

    progress_path = tmp_path / 'assessments' / 'V1' / 'runs' / record.run_id / 'progress.jsonl'
    assert progress_path.exists()
    last_line = progress_path.read_text().splitlines()[-1]
    last = json.loads(last_line)
    assert last['kind'] == 'run_done'
    assert last['stage'] == 'aggregate'


async def test_run_transitions_to_error_on_pipeline_exception(tmp_path: Path) -> None:
    async def boom(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError('flowa boom')

    manager = _make_manager(tmp_path, pipeline=boom)
    record = manager.start(variant_id='V2', variant_spec=_spec())
    await manager.wait(record.run_id)

    assert manager.get_active('V2').status == 'error'  # type: ignore[union-attr]

    progress_path = tmp_path / 'assessments' / 'V2' / 'runs' / record.run_id / 'progress.jsonl'
    last = json.loads(progress_path.read_text().splitlines()[-1])
    assert last['kind'] == 'run_error'
    assert last['error'] == 'flowa boom'


async def test_in_flight_run_for_same_variant_returns_409(tmp_path: Path) -> None:
    # A pipeline that never completes within the test, holding the slot.
    never_returns = asyncio.Event()

    async def hangs(*_args: object, **_kwargs: object) -> None:
        await never_returns.wait()

    manager = _make_manager(tmp_path, pipeline=hangs)
    manager.start(variant_id='V3', variant_spec=_spec())

    with pytest.raises(HTTPException) as exc_info:
        manager.start(variant_id='V3', variant_spec=_spec())
    assert exc_info.value.status_code == 409

    # Allow the hanging coroutine to terminate so the test event-loop
    # closes cleanly.
    never_returns.set()
    record = manager.get_active('V3')
    assert record is not None
    await manager.wait(record.run_id)


async def test_concurrency_cap_returns_429(tmp_path: Path) -> None:
    never_returns = asyncio.Event()

    async def hangs(*_args: object, **_kwargs: object) -> None:
        await never_returns.wait()

    manager = _make_manager(tmp_path, pipeline=hangs, max_concurrent_runs=2)
    manager.start(variant_id='A', variant_spec=_spec())
    manager.start(variant_id='B', variant_spec=_spec())

    with pytest.raises(HTTPException) as exc_info:
        manager.start(variant_id='C', variant_spec=_spec())
    assert exc_info.value.status_code == 429

    never_returns.set()
    for record in manager.records.values():
        await manager.wait(record.run_id)


async def test_completed_run_does_not_block_a_new_run_for_same_variant(tmp_path: Path) -> None:
    manager = _make_manager(tmp_path, pipeline=_no_op)
    first = manager.start(variant_id='V', variant_spec=_spec())
    await manager.wait(first.run_id)
    assert manager.get_active('V').status == 'success'  # type: ignore[union-attr]

    # A new run for the same variant should succeed and replace the record.
    second = manager.start(variant_id='V', variant_spec=_spec())
    assert second.run_id != first.run_id
    assert manager.get_active('V').status == 'running'  # type: ignore[union-attr]
    await manager.wait(second.run_id)


async def test_pipeline_progress_events_land_in_jsonl(tmp_path: Path) -> None:
    """Stub pipeline emits events through the on_progress callback;
    the runner adds run_done at the end. Round-trip should preserve order."""

    async def emits(_settings: object, *, on_progress: ProgressCallback | None = None, **_kwargs: object) -> None:
        assert on_progress is not None
        on_progress(ProgressEvent(timestamp=now_iso(), stage='query', kind='stage_started'))
        on_progress(ProgressEvent(timestamp=now_iso(), stage='query', kind='stage_done', done=0, total=0))

    manager = _make_manager(tmp_path, pipeline=emits)
    record = manager.start(variant_id='V', variant_spec=_spec())
    await manager.wait(record.run_id)

    lines = (tmp_path / 'assessments' / 'V' / 'runs' / record.run_id / 'progress.jsonl').read_text().splitlines()
    parsed = [json.loads(line) for line in lines if line]
    kinds = [(p['stage'], p['kind']) for p in parsed]
    assert kinds == [
        ('query', 'stage_started'),
        ('query', 'stage_done'),
        ('aggregate', 'run_done'),
    ]
