"""Progress events for pipeline observability.

Pipeline runs emit `ProgressEvent`s through an optional `on_progress` callback
threaded into `flowa.aggregate(...)`. Consumers (e.g. a demo gateway, or
production progress sink writing to S3) attach the callback to materialise
events however they need; flowa itself stays transport-agnostic.
"""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

Stage = Literal['query', 'download', 'convert', 'extract', 'aggregate']
"""The pipeline stage an event belongs to. Pipeline ordering is
query -> (download -> convert -> extract per paper, in parallel) -> aggregate."""

EventKind = Literal['stage_started', 'paper', 'stage_done', 'run_done', 'run_error']
"""Coarse classification of an event. `paper` events carry per-paper progress
within a stage; `stage_started` / `stage_done` bracket single-shot stages
(`query` and `aggregate`); `run_done` / `run_error` are emitted by the
pipeline-driving consumer (not by flowa itself) when the entire run terminates."""


@dataclass(frozen=True)
class ProgressEvent:
    """One discrete observation of pipeline state.

    Frozen so consumers can pass references freely. JSON-serialise with
    `dataclasses.asdict(...)` -> `json.dumps(...)`.
    """

    timestamp: str
    """ISO 8601 UTC, millisecond precision."""

    stage: Stage
    """Which pipeline stage this event came from."""

    kind: EventKind
    """What happened. See `EventKind` for the closed set."""

    paper_id: str | None = None
    """DOI or identifier of the paper this event is about, if applicable."""

    done: int | None = None
    """Stage progress counter: number of papers that have completed this stage."""

    total: int | None = None
    """Total papers expected for this stage's counter."""

    detail: str | None = None
    """Free-form short human-readable text. Safe to surface in UI."""

    error: str | None = None
    """Set on `run_error`; the exception's stringified message."""


ProgressCallback = Callable[[ProgressEvent], None]
"""The shape consumers attach via `on_progress=`. Sync callable. Called from
the pipeline's event loop thread; consumers wanting cross-thread delivery are
responsible for marshalling."""


def now_iso() -> str:
    """ISO 8601 UTC timestamp, millisecond precision. Stable across stages."""
    return datetime.now(UTC).isoformat(timespec='milliseconds')


def emit(callback: ProgressCallback | None, event: ProgressEvent) -> None:
    """No-op when callback is None; otherwise delegate. Centralised so callers
    don't sprinkle `if callback:` guards across the pipeline."""
    if callback is not None:
        callback(event)
