"""Tests for `flowa.pdf_index_cache`.

PdfIndex itself is exercised by anchorite's own suite — these tests cover
this module's responsibilities: that the on-the-wire format round-trips
cleanly, that the resolver behaviour is preserved across pickle, and that
the header guards reject artifacts that would silently produce wrong bboxes.

The fixture is a generated blank PDF (~430 bytes). Anchorite handles
blank PDFs by returning empty lists for any quote, which is enough to
verify identical pre- and post-pickle behaviour without committing a
binary fixture.
"""

import io
import pickle

import pytest
import zstandard
from pypdf import PdfWriter

from flowa.pdf_index_cache import (
    FORMAT_VERSION,
    ZSTD_LEVEL,
    PdfIndexPayload,
    StaleIndexError,
    build,
    deserialize,
    serialize,
)


@pytest.fixture
def pdf_bytes() -> bytes:
    """A minimal valid PDF — one blank page, ~430 bytes."""
    writer = PdfWriter()
    writer.add_blank_page(width=600, height=800)
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


MARKDOWN = '# Sample\n\nblank-page transcription'


def test_build_pins_sha256_and_format_version(pdf_bytes: bytes) -> None:
    payload = build(pdf_bytes, MARKDOWN)
    assert payload.format_version == FORMAT_VERSION
    # Tied to the exact bytes, not to PdfIndex internals.
    assert len(payload.source_pdf_sha256) == 64
    other_payload = build(pdf_bytes + b' ', MARKDOWN)
    assert other_payload.source_pdf_sha256 != payload.source_pdf_sha256


def test_round_trip_preserves_resolve_behaviour(pdf_bytes: bytes) -> None:
    """A pickled-and-restored index resolves identically to the original."""
    payload = build(pdf_bytes, MARKDOWN)
    blob = serialize(payload)
    restored = deserialize(blob)

    quote = 'any text — empty PDF returns no bboxes regardless'
    assert payload.pdf_index.resolve([quote]) == restored.pdf_index.resolve([quote])
    assert restored.source_pdf_sha256 == payload.source_pdf_sha256
    assert restored.format_version == payload.format_version


def test_serialize_compresses_with_zstd(pdf_bytes: bytes) -> None:
    """The serialised blob is a valid zstd frame, not raw pickle bytes."""
    blob = serialize(build(pdf_bytes, MARKDOWN))
    # zstd frame magic number (RFC 8478 §3.1.1).
    assert blob[:4] == b'\x28\xb5\x2f\xfd'


def test_deserialize_rejects_wrong_format_version(pdf_bytes: bytes) -> None:
    """A pickle written under a future format version must not silently load."""
    payload = build(pdf_bytes, MARKDOWN)
    # Hand-craft the blob so we can pin a format_version the runtime doesn't
    # know about — `serialize` would always stamp the current FORMAT_VERSION.
    pkl = pickle.dumps(
        {
            'format_version': FORMAT_VERSION + 1,
            'source_pdf_sha256': payload.source_pdf_sha256,
            'pdf_index': payload.pdf_index,
        },
        protocol=pickle.HIGHEST_PROTOCOL,
    )
    blob = zstandard.ZstdCompressor(level=ZSTD_LEVEL).compress(pkl)
    with pytest.raises(StaleIndexError, match='format version mismatch'):
        deserialize(blob)


def test_deserialize_rejects_pdf_sha_mismatch_when_caller_checks(pdf_bytes: bytes) -> None:
    """If caller supplies expected_pdf_sha256, mismatch is fatal."""
    blob = serialize(build(pdf_bytes, MARKDOWN))
    with pytest.raises(StaleIndexError, match='hash mismatch'):
        deserialize(blob, expected_pdf_sha256='deadbeef' * 8)


def test_deserialize_skips_pdf_sha_check_by_default(pdf_bytes: bytes) -> None:
    """Gateway path: deserialize without `expected_pdf_sha256` ignores the hash."""
    blob = serialize(build(pdf_bytes, MARKDOWN))
    restored = deserialize(blob)
    assert isinstance(restored, PdfIndexPayload)


def test_zstd_level_constant_is_within_expected_range() -> None:
    """Sanity-check the level constant — guard against an accidental zero."""
    assert 1 <= ZSTD_LEVEL <= 22


def test_deserialize_rejects_corrupt_blob() -> None:
    """A blob that isn't a valid zstd frame must not silently succeed."""
    with pytest.raises(zstandard.ZstdError):
        deserialize(b'not a zstd frame')


def test_deserialize_rejects_unpickleable_body(pdf_bytes: bytes) -> None:
    """A zstd-compressed-but-not-pickled body must not silently succeed."""
    blob = zstandard.ZstdCompressor(level=ZSTD_LEVEL).compress(b'not a pickle')
    with pytest.raises(pickle.UnpicklingError):
        deserialize(blob)
