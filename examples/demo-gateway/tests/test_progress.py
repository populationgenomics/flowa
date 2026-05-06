"""ProgressSink writes events atomically and round-trips JSON."""

import json
from pathlib import Path

from flowa.progress import ProgressEvent, now_iso

from demo_gateway.progress import ProgressSink


def test_appends_event_writes_jsonl_line(tmp_path: Path) -> None:
    sink = ProgressSink(tmp_path / 'runs' / 'r1' / 'progress.jsonl')
    sink.append(ProgressEvent(timestamp=now_iso(), stage='query', kind='stage_started'))

    contents = (tmp_path / 'runs' / 'r1' / 'progress.jsonl').read_text()
    lines = [line for line in contents.splitlines() if line]
    assert len(lines) == 1
    parsed = json.loads(lines[0])
    assert parsed['stage'] == 'query'
    assert parsed['kind'] == 'stage_started'


def test_subsequent_appends_rewrite_full_snapshot(tmp_path: Path) -> None:
    sink = ProgressSink(tmp_path / 'progress.jsonl')
    sink.append(ProgressEvent(timestamp=now_iso(), stage='query', kind='stage_started'))
    sink.append(ProgressEvent(timestamp=now_iso(), stage='query', kind='stage_done', done=2, total=2))

    contents = (tmp_path / 'progress.jsonl').read_text()
    lines = [line for line in contents.splitlines() if line]
    assert len(lines) == 2

    parsed = [json.loads(line) for line in lines]
    assert parsed[0]['kind'] == 'stage_started'
    assert parsed[1]['kind'] == 'stage_done'
    assert parsed[1]['done'] == 2


def test_temp_file_is_cleaned_up_on_each_append(tmp_path: Path) -> None:
    """The .tmp file should not linger after an append (atomic rename
    semantics): only progress.jsonl exists in the directory."""
    sink = ProgressSink(tmp_path / 'progress.jsonl')
    sink.append(ProgressEvent(timestamp=now_iso(), stage='aggregate', kind='run_done'))

    files = sorted(p.name for p in tmp_path.iterdir())
    assert files == ['progress.jsonl']


def test_events_property_returns_a_copy(tmp_path: Path) -> None:
    sink = ProgressSink(tmp_path / 'progress.jsonl')
    ev = ProgressEvent(timestamp=now_iso(), stage='query', kind='stage_started')
    sink.append(ev)

    snapshot = sink.events
    snapshot.clear()  # mutating the snapshot must not affect the sink
    assert sink.events == [ev]
