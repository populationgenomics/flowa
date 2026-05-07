"""Citation-bbox resolver: align verbatim quotes to PDF page+bbox locations.

Two entry points:

- `resolve_citation_in_pdf(pdf_bytes, quotes)` — pure, no I/O. For callers that
  already hold PDF bytes (e.g. `flowa.aggregate`'s post-LLM step).
- `resolve_citations(citations, pdf_loader)` — fetches each DOI's source PDF via
  the supplied loader and resolves all quotes. Used by demo-gateway and the
  `flowa resolve` CLI.

Wire-format types (`CitationQuery`, `HighlightBbox`, `ResolvedCitations`,
`ResolveRequest`) are the canonical Pydantic shapes shared with HTTP consumers.
"""

import json
import logging
import sys
import time
from collections.abc import Callable

import typer
from groundmark import DocumentIndex
from pydantic import BaseModel, Field

from flowa.storage import paper_url, read_bytes

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
    PDF. An empty list means the quote was searched but groundmark could not align
    it. DOIs whose PDF could not be loaded at all are absent from `resolved` and
    surface in `errors` instead — consumers can distinguish "PDF unavailable" from
    "quote not found in PDF".
    """

    resolved: dict[str, dict[str, list[HighlightBbox]]] = Field(default_factory=dict)
    errors: dict[str, str] = Field(default_factory=dict)


class ResolveRequest(BaseModel):
    """HTTP request wrapper used by demo-gateway and other HTTP consumers."""

    citations: list[CitationQuery]


# --- Resolver ---------------------------------------------------------------

PdfLoader = Callable[[str], bytes | None]


def resolve_citation_in_pdf(pdf_bytes: bytes, quotes: list[str]) -> dict[str, list[HighlightBbox]]:
    """Build a DocumentIndex over the PDF bytes and align each quote.

    Returns one entry per input quote (empty list when groundmark could not locate
    it). Consumers of `resolve_citations` distinguish "no match" (empty list here)
    from "PDF unavailable" (DOI absent from the surrounding result entirely).
    """
    if not quotes:
        return {}
    doc = DocumentIndex(pdf_bytes)
    raw = doc.resolve(quotes)
    return {
        quote: [
            HighlightBbox(page=page, top=bbox.top, left=bbox.left, bottom=bbox.bottom, right=bbox.right)
            for page, bbox in raw.get(quote, [])
        ]
        for quote in quotes
    }


def resolve_citations(citations: list[CitationQuery], pdf_loader: PdfLoader) -> ResolvedCitations:
    """Resolve quote-to-bbox mappings for a batch of (DOI, quotes) inputs.

    `pdf_loader(doi)` returns source PDF bytes or `None` when the PDF is unavailable
    (populates `result.errors[doi]`). Other exceptions propagate.
    """
    resolved: dict[str, dict[str, list[HighlightBbox]]] = {}
    errors: dict[str, str] = {}
    total_start = time.monotonic()

    for citation in citations:
        pdf_bytes = pdf_loader(citation.doi)
        if pdf_bytes is None:
            log.warning('PDF not available for %s', citation.doi)
            errors[citation.doi] = 'source.pdf not found'
            continue
        t0 = time.monotonic()
        bboxes_by_quote = resolve_citation_in_pdf(pdf_bytes, citation.quotes)
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


# --- CLI --------------------------------------------------------------------


def resolve(
    base: str = typer.Option(
        ...,
        '--base',
        help=(
            'Storage base URL (e.g. s3://bucket, gs://bucket, ./local-dir). '
            'PDFs are fetched from {base}/papers/{encoded_doi}/source.pdf via fsspec.'
        ),
    ),
) -> None:
    """Resolve citation quotes to PDF bounding boxes.

    Reads `{ "citations": [ { "doi": "...", "quotes": ["..."] } ] }` from stdin.
    Writes `{ "resolved": {...}, "errors": {...} }` to stdout.
    """
    payload = json.load(sys.stdin)
    citations = [CitationQuery.model_validate(c) for c in payload['citations']]

    def loader(doi: str) -> bytes | None:
        try:
            return read_bytes(paper_url(base, doi, 'source.pdf'))
        except FileNotFoundError:
            return None

    result = resolve_citations(citations, pdf_loader=loader)
    json.dump(result.model_dump(), sys.stdout)
    sys.stdout.write('\n')
