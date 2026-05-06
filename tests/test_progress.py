"""Smoke tests for the progress-event surface.

End-to-end emission is exercised by the demo-gateway tests; here we just
pin down the dataclass shape and the no-op semantics of `emit()` so the
contract pipeline consumers code against doesn't drift silently.
"""

from dataclasses import FrozenInstanceError, asdict
from datetime import datetime

import pytest

from flowa.progress import ProgressEvent, emit, now_iso


def test_now_iso_round_trips_to_datetime():
    s = now_iso()
    parsed = datetime.fromisoformat(s)
    # Must carry timezone so consumers don't have to guess.
    assert parsed.tzinfo is not None


def test_progress_event_is_frozen():
    ev = ProgressEvent(timestamp=now_iso(), stage='query', kind='stage_started')
    with pytest.raises(FrozenInstanceError):
        ev.kind = 'paper'  # type: ignore[misc]


def test_progress_event_serialises_to_dict_with_optional_fields_present():
    ev = ProgressEvent(
        timestamp='2026-05-07T00:00:00.000+00:00',
        stage='download',
        kind='paper',
        paper_id='10.1234/foo',
        done=1,
        total=12,
    )
    d = asdict(ev)
    # All declared fields appear (dataclass dict semantics), with absent
    # optional fields preserved as None — important so JSONL consumers can
    # rely on a stable schema across events.
    assert d == {
        'timestamp': '2026-05-07T00:00:00.000+00:00',
        'stage': 'download',
        'kind': 'paper',
        'paper_id': '10.1234/foo',
        'done': 1,
        'total': 12,
        'detail': None,
        'error': None,
    }


def test_emit_is_noop_when_callback_is_none():
    # Should not raise. The pipeline relies on this so callers can pass
    # `on_progress=None` without sprinkling guards.
    emit(None, ProgressEvent(timestamp=now_iso(), stage='aggregate', kind='stage_started'))


def test_emit_forwards_to_callback():
    received: list[ProgressEvent] = []
    ev = ProgressEvent(timestamp=now_iso(), stage='aggregate', kind='stage_done')
    emit(received.append, ev)
    assert received == [ev]
