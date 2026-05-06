"""Per-run progress sink that materialises ProgressEvents to a JSONL file.

The sink keeps the canonical event list in memory and rewrites the entire
`progress.jsonl` on each event via tempfile + atomic rename. POSIX rename is
atomic, so concurrent readers always see a consistent file (no torn lines,
no half-written events).

This shape mirrors what production would do in S3: each event triggers a
full PUT of the snapshot. Only the destination differs (local FS rename vs
S3 PUT). Cost is small: even for full runs the file stays under ~50 KB and
events are seconds apart.
"""

import json
import threading
from dataclasses import asdict
from pathlib import Path

from flowa.progress import ProgressEvent


class ProgressSink:
    """Append-and-snapshot sink for one run's progress.jsonl.

    Construct with the destination path. `append(event)` is callback-safe —
    it can be passed directly as flowa's `on_progress=` argument.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self._tmp = path.with_suffix(path.suffix + '.tmp')
        self._events: list[ProgressEvent] = []
        # Lock guards the in-memory list + file rewrite. asyncio's cooperative
        # scheduling alone would suffice for single-event-loop callers, but
        # the lock costs nothing and survives misuse from a future caller
        # that drives the sink from a different thread.
        self._lock = threading.Lock()
        path.parent.mkdir(parents=True, exist_ok=True)

    def append(self, event: ProgressEvent) -> None:
        """Add `event` to the canonical list and rewrite the snapshot file."""
        with self._lock:
            self._events.append(event)
            with self._tmp.open('w') as fh:
                for ev in self._events:
                    fh.write(json.dumps(asdict(ev), separators=(',', ':')) + '\n')
            self._tmp.replace(self.path)

    @property
    def events(self) -> list[ProgressEvent]:
        """Snapshot of the in-memory event list. Returns a copy so callers
        can iterate without holding the lock."""
        with self._lock:
            return list(self._events)
