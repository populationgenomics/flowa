"""Process-wide single-thread lane for all PDFium (pypdfium2) work.

PDFium holds global process state and is not thread-safe. anchorite documents
that `PdfIndex(...)` construction — and, by the same token, `chunks()`'s page
splitting — must be serialised by the caller (see `anchorite.PdfIndex`:
"construction is *not* thread-safe (PDFium isn't); serialise concurrent
`PdfIndex(...)` calls in the caller").

flowa drives up to `--convert-concurrency` papers at once, and its two PDFium
entry points run on different threads: chunk-splitting on the event-loop thread
and index construction on a worker thread. Left unserialised, those calls hit
PDFium's shared state from several threads simultaneously and corrupt it — an
intermittent native crash (SIGTRAP) that spikes on index-dense runs (e.g. a
backfill where most papers already have transcriptions, so convert is mostly
the index step). The GIL does not protect them: ctypes releases it across the
PDFium FFI calls.

Routing every PDFium-touching callable through this one-worker executor makes
them mutually exclusive *by construction* — there is no lock to forget, and
PDFium is physically isolated from the general thread pool. Throughput is
unaffected: the serialised PDFium time (chunk-split is tens of ms, index build
0.2-8s) hides under the much longer, fully-concurrent Bedrock transcription.
"""

import asyncio
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor

# One worker => every callable submitted here runs to completion before the
# next starts, so all PDFium work is serialised. Module-level (process-global)
# because PDFium's state is process-global; the lone idle thread is negligible.
_PDFIUM_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix='pdfium')


async def run_pdfium[T](fn: Callable[[], T]) -> T:
    """Run a synchronous PDFium-touching callable on the single PDFium thread.

    `fn` must perform *all* of its PDFium work before returning — fully
    materialise any lazy generator (e.g. `list(chunks(...))`), don't hand back
    an iterator that would call into PDFium later on another thread.
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_PDFIUM_EXECUTOR, fn)
