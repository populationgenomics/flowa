"""Tests for `flowa.pdfium` — the single-thread PDFium lane.

PDFium is not thread-safe, so `run_pdfium` must serialise every callable it
runs onto one dedicated worker thread. These tests assert that property
directly — concurrently-submitted callables never overlap in time and all run
on the same thread — which makes the mutual-exclusion guarantee verifiable
without provoking a native PDFium race.
"""

import asyncio
import threading
import time
from itertools import pairwise

from flowa.pdfium import run_pdfium


def _record(hold: float) -> tuple[int, str, float, float]:
    """Return (thread_id, thread_name, enter, exit) around a short sleep.

    Runs on the PDFium worker thread; the sleep widens each call's interval so
    a second worker would produce a detectable overlap.
    """
    enter = time.perf_counter()
    time.sleep(hold)
    return (threading.get_ident(), threading.current_thread().name, enter, time.perf_counter())


def test_run_pdfium_serialises_concurrent_calls() -> None:
    hold = 0.02
    n = 8

    async def drive() -> list[tuple[int, str, float, float]]:
        return list(await asyncio.gather(*(run_pdfium(lambda: _record(hold)) for _ in range(n))))

    records = asyncio.run(drive())
    assert len(records) == n

    # Every callable ran on the one PDFium worker thread.
    assert len({tid for tid, _, _, _ in records}) == 1
    assert all(name.startswith('pdfium') for _, name, _, _ in records)

    # Intervals are pairwise non-overlapping: sorted by entry, each call starts
    # only after the previous one finished — a single worker runs them serially.
    intervals = sorted((enter, exit_) for _, _, enter, exit_ in records)
    for (_, prev_exit), (next_enter, _) in pairwise(intervals):
        assert next_enter >= prev_exit
