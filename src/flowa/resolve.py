"""Citation-bbox resolver: align verbatim quotes to PDF page+bbox locations.

The resolver doesn't construct `PdfIndex` objects itself. Construction
dominates per-call latency (~8s on the deployed gateway hardware against
~300ms for the actual alignment), so every paper carries a pre-built
`pdf_index.pkl.zst` next to its `source.pdf` — written by `flowa.convert`
when the paper is first transcribed, and persisted in storage thereafter.
Callers supply an `index_provider` that loads the pickle for a given DOI.

Wire-format types (`CitationQuery`, `HighlightBbox`, `ResolvedCitations`,
`ResolveRequest`) are the canonical Pydantic shapes shared with HTTP consumers.
"""

import json
import logging
import sys
import time
from collections.abc import Callable

import typer
from anchorite import PdfIndex
from pydantic import BaseModel, Field

from flowa.pdf_index_cache import deserialize as deserialize_pdf_index_payload
from flowa.storage import exists, paper_url, read_bytes

log = logging.getLogger(__name__)


# --- Wire-format types -------------------------------------------------------


class CitationQuery(BaseModel):
    """Input: a DOI plus the verbatim quotes to align against its source PDF."""

    doi: str = Field(description='Document identifier whose source PDF holds the quotes.')
    quotes: list[str] = Field(description='Verbatim quotes to align.')


class HighlightBbox(BaseModel):
    """A bounding box on a single PDF page (0-1000 normalized scale, 1-indexed pages)."""

    page: int
    top: int
    left: int
    bottom: int
    right: int


class ResolvedCitations(BaseModel):
    """Output: resolved bboxes per (DOI, quote) plus per-DOI fetch errors.

    `resolved[doi][quote]` is the list of bboxes for `quote` in that DOI's source
    PDF. An empty list means the quote was searched but could not be aligned with
    sufficient confidence. DOIs whose `PdfIndex` could not be loaded are absent
    from `resolved` and surface in `errors` — consumers can distinguish "index
    unavailable" from "quote not found".
    """

    resolved: dict[str, dict[str, list[HighlightBbox]]] = Field(default_factory=dict)
    errors: dict[str, str] = Field(default_factory=dict)


class ResolveRequest(BaseModel):
    """HTTP request wrapper used by demo-gateway and other HTTP consumers."""

    citations: list[CitationQuery]


# --- Resolver ---------------------------------------------------------------

IndexProvider = Callable[[str], PdfIndex | None]


def resolve_quotes_in_index(pdf_index: PdfIndex, quotes: list[str]) -> dict[str, list[HighlightBbox]]:
    """Align each quote against an already-constructed `PdfIndex`.

    Pure — no I/O. Returns one entry per input quote (empty list when no
    alignment scored above anchorite's threshold).
    """
    if not quotes:
        return {}
    raw = pdf_index.resolve(quotes)
    return {
        quote: [
            # anchorite returns 0-indexed pages; flowa's downstream wire format
            # (storage JSON, HTTP responses, frontend) is 1-indexed. Wrap at the
            # boundary so no consumer sees the 0-indexed form.
            HighlightBbox(page=page + 1, top=bbox.top, left=bbox.left, bottom=bbox.bottom, right=bbox.right)
            for page, bbox in raw.get(quote, [])
        ]
        for quote in quotes
    }


def resolve_citations(
    citations: list[CitationQuery],
    index_provider: IndexProvider,
) -> ResolvedCitations:
    """Resolve quote-to-bbox mappings for a batch of (DOI, quotes) inputs.

    `index_provider(doi)` returns a `PdfIndex` for the DOI, or `None` if the
    artifact is unavailable. `None` is surfaced as a per-DOI error in
    `result.errors`. Other exceptions propagate.
    """
    resolved: dict[str, dict[str, list[HighlightBbox]]] = {}
    errors: dict[str, str] = {}
    total_start = time.monotonic()

    for citation in citations:
        pdf_index = index_provider(citation.doi)
        if pdf_index is None:
            log.warning('PdfIndex not available for %s', citation.doi)
            errors[citation.doi] = 'pdf_index not available'
            continue
        t0 = time.monotonic()
        bboxes_by_quote = resolve_quotes_in_index(pdf_index, citation.quotes)
        elapsed = time.monotonic() - t0
        resolved_count = sum(1 for q in citation.quotes if bboxes_by_quote.get(q))
        log.info(
            'Resolved %s: %d/%d quotes in %.1fs',
            citation.doi,
            resolved_count,
            len(citation.quotes),
            elapsed,
        )
        resolved[citation.doi] = bboxes_by_quote

    total_elapsed = time.monotonic() - total_start
    total_quotes = sum(len(c.quotes) for c in citations)
    total_resolved = sum(sum(1 for q in c.quotes if resolved.get(c.doi, {}).get(q)) for c in citations)
    log.info(
        'Citation resolution complete: %d/%d quotes across %d papers in %.1fs',
        total_resolved,
        total_quotes,
        len(citations),
        total_elapsed,
    )

    return ResolvedCitations(resolved=resolved, errors=errors)


def load_pdf_index_from_storage(base: str, doi: str) -> PdfIndex | None:
    """Read and deserialise `papers/{doi}/pdf_index.pkl.zst` from a flowa storage base.

    Returns `None` when the artifact is missing. Storage exceptions and
    pickle/header errors propagate — the caller decides whether stale or
    corrupt artifacts are recoverable.

    Used by every in-process caller (aggregate post-LLM, CLI). Out-of-process
    consumers (`flowa-gateway`) implement their own loader against whichever
    storage client they already hold.
    """
    index_url = paper_url(base, doi, 'pdf_index.pkl.zst')
    if not exists(index_url):
        return None
    blob = read_bytes(index_url)
    return deserialize_pdf_index_payload(blob).pdf_index


# --- CLI --------------------------------------------------------------------


def resolve(
    base: str = typer.Option(
        ...,
        '--base',
        help=(
            'Storage base URL (e.g. s3://bucket, gs://bucket, ./local-dir). '
            'Indices are read from {base}/papers/{encoded_doi}/pdf_index.pkl.zst.'
        ),
    ),
) -> None:
    """Resolve citation quotes to PDF bounding boxes.

    Reads `{ "citations": [ { "doi": "...", "quotes": ["..."] } ] }` from stdin.
    Writes `{ "resolved": {...}, "errors": {...} }` to stdout.

    DOIs whose `pdf_index.pkl.zst` is missing from storage surface in
    `errors` rather than rebuilding the index from source.pdf on the fly —
    run `flowa convert` (or backfill) to produce the artifact.
    """
    payload = json.load(sys.stdin)
    citations = [CitationQuery.model_validate(c) for c in payload['citations']]
    result = resolve_citations(
        citations,
        index_provider=lambda doi: load_pdf_index_from_storage(base, doi),
    )
    json.dump(result.model_dump(), sys.stdout)
    sys.stdout.write('\n')
