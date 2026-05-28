"""Build, serialise, and load cached `PdfIndex` artifacts.

The gateway's per-call cost is dominated by `PdfIndex(pdf_bytes)` construction
— ~8s on the deployed gateway hardware for a typical paper, against ~300ms
for the actual quote alignment afterwards. To avoid paying that on every
`/api/v1/resolve` call, the pipeline persists the constructed index at
`papers/{encoded_doi}/pdf_index.pkl.zst` so the gateway can load instead of
rebuild.

On-the-wire format: zstd-compressed pickle of a single dict:

    {
        "format_version":   int,    # bumped when this module changes what it serialises
        "source_pdf_sha256": str,   # sha256 hex digest of source.pdf bytes
        "pdf_index":        PdfIndex,
    }

The header fields let `deserialize` reject artifacts that are out of sync
with the current source.pdf or with the current cache format — a stale
pickle would silently produce wrong bboxes. The format version is *our*
contract over the persisted shape: bump it when this module changes which
fields it stores or how it stores them. It is not tied to anchorite's
release cadence — anchorite patch/minor releases that preserve the pickle
shape of `PdfIndex` deserialise fine.

zstd level 3 was chosen empirically (see specs/supplements.md): ~5x faster
compression than gzip -6 at comparable ratio (~1/5 of the pickled size),
and a touch faster decompression. The pipeline pays the compress cost once
per paper; the gateway pays the decompress cost on every cold load, so
optimising for both directions matters.

Anchorite documents that `PdfIndex` pickles cleanly (state is str/bytes/
list[int]/frozen dataclasses); no custom reducers needed.
"""

from __future__ import annotations

import hashlib
import pickle
from dataclasses import dataclass

import zstandard
from anchorite import PdfIndex

# Bump when the persisted shape changes: new fields, removed fields, semantic
# meaning changes. Anchorite version bumps that preserve `PdfIndex` pickle
# compatibility do NOT require a bump here — those deserialise correctly
# under the existing format. If a new anchorite release changes `PdfIndex`'s
# internals such that old pickles still load but produce different bboxes,
# bump this to force a re-backfill.
FORMAT_VERSION = 1

ZSTD_LEVEL = 3
PICKLE_PROTOCOL = pickle.HIGHEST_PROTOCOL


class StaleIndexError(Exception):
    """Persisted artifact's header doesn't match the runtime expectation.

    Raised by `deserialize` when the pickle was written under a different
    `FORMAT_VERSION` or against a source.pdf with a different sha256. The
    caller decides whether to rebuild or surface an error — this module
    deliberately doesn't fall back, because silent rebuild masks pipeline
    drift.
    """


@dataclass(frozen=True)
class PdfIndexPayload:
    """In-memory view of the persisted artifact."""

    format_version: int
    source_pdf_sha256: str
    pdf_index: PdfIndex


def build(pdf_bytes: bytes, markdown: str) -> PdfIndexPayload:
    """Construct a PdfIndex pinned to its source PDF by sha256.

    `markdown` is the paper's transcription, used by anchorite to denoise the
    indexed PDF char string (drop running heads, page numbers, footnote
    markers the LLM didn't transcribe), which improves quote alignment.
    """
    # markdown is threaded through but not yet forwarded to PdfIndex: the
    # anchorite-#19 markdown denoise drops entire pages of atoms when the
    # markdown reorders content relative to PDF page order. Switch to
    # `markdown=markdown` once the upstream fix lands — and bump
    # FORMAT_VERSION + re-backfill, since the denoised index resolves quotes
    # against a different cached char string (existing pickles would silently
    # produce different bboxes).
    return PdfIndexPayload(
        format_version=FORMAT_VERSION,
        source_pdf_sha256=hashlib.sha256(pdf_bytes).hexdigest(),
        pdf_index=PdfIndex(pdf_bytes, markdown=None),
    )


def serialize(payload: PdfIndexPayload) -> bytes:
    """Pickle + zstd-compress for upload to S3."""
    pkl = pickle.dumps(
        {
            'format_version': payload.format_version,
            'source_pdf_sha256': payload.source_pdf_sha256,
            'pdf_index': payload.pdf_index,
        },
        protocol=PICKLE_PROTOCOL,
    )
    return zstandard.ZstdCompressor(level=ZSTD_LEVEL).compress(pkl)


def deserialize(blob: bytes, *, expected_pdf_sha256: str | None = None) -> PdfIndexPayload:
    """Decompress + unpickle. Verifies the header before returning.

    The runtime `FORMAT_VERSION` is always checked. The `source_pdf_sha256`
    check is only performed when the caller supplies a value to compare
    against — the gateway typically skips it (would require fetching source.pdf
    just to hash it). Callers that already have the source bytes pass the
    digest in to catch pipeline drift.
    """
    pkl = zstandard.ZstdDecompressor().decompress(blob)
    raw = pickle.loads(pkl)
    payload = PdfIndexPayload(
        format_version=raw['format_version'],
        source_pdf_sha256=raw['source_pdf_sha256'],
        pdf_index=raw['pdf_index'],
    )
    if payload.format_version != FORMAT_VERSION:
        raise StaleIndexError(f'format version mismatch: pickle={payload.format_version!r} runtime={FORMAT_VERSION!r}')
    if expected_pdf_sha256 is not None and payload.source_pdf_sha256 != expected_pdf_sha256:
        raise StaleIndexError(
            f'source.pdf hash mismatch: pickle={payload.source_pdf_sha256!r} actual={expected_pdf_sha256!r}'
        )
    return payload
