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
from anchorite import PdfIndex  # type: ignore[import-untyped]
from pydantic import BaseModel, Field

from flowa.storage import paper_url, read_bytes, read_text

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
    sufficient confidence. DOIs whose source.pdf or markdown.md could not be
    loaded are absent from `resolved` and surface in `errors` instead — consumers
    can distinguish "asset unavailable" from "quote not found in PDF".
    """

    resolved: dict[str, dict[str, list[HighlightBbox]]] = Field(default_factory=dict)
    errors: dict[str, str] = Field(default_factory=dict)


class ResolveRequest(BaseModel):
    """HTTP request wrapper used by demo-gateway and other HTTP consumers."""

    citations: list[CitationQuery]


# --- Resolver ---------------------------------------------------------------

PdfLoader = Callable[[str], bytes | None]
MarkdownLoader = Callable[[str], str | None]


def resolve_citation_in_pdf(
    pdf_bytes: bytes,
    quotes: list[str],
    markdown: str,
) -> dict[str, list[HighlightBbox]]:
    """Build a PdfIndex over the PDF bytes and align each quote.

    `markdown` is required — anchorite uses it to denoise the cached PDF char
    string (drop running heads / page numbers / footnote markers the LLM didn't
    transcribe), which materially improves quote alignment.

    Returns one entry per input quote (empty list when no alignment scored above
    anchorite's threshold). Consumers of `resolve_citations` distinguish "no
    match" (empty list here) from "asset unavailable" (DOI absent from the
    surrounding result entirely).
    """
    if not quotes:
        return {}
    # TODO: pass `markdown=markdown` once anchorite's markdown-aware denoise is
    # fixed — its monotonic chained-alignment drops entire pages when markdown
    # reorders content relative to PDF page order, leaving the resolver unable
    # to match quotes from those pages.
    doc = PdfIndex(pdf_bytes, markdown=None)
    raw = doc.resolve(quotes)
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
    pdf_loader: PdfLoader,
    markdown_loader: MarkdownLoader,
) -> ResolvedCitations:
    """Resolve quote-to-bbox mappings for a batch of (DOI, quotes) inputs.

    `pdf_loader(doi)` returns source PDF bytes; `markdown_loader(doi)` returns
    the LLM-generated Markdown transcription. Either returning `None` is surfaced
    as a per-DOI error in `result.errors`. Other exceptions propagate.

    The pipeline produces source.pdf and markdown.md together, so finding one
    without the other indicates a storage-invariant violation. The handler logs
    a warning and continues with the next DOI.
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
        markdown = markdown_loader(citation.doi)
        if markdown is None:
            log.warning('Markdown not available for %s (source.pdf present)', citation.doi)
            errors[citation.doi] = 'markdown.md not found'
            continue
        t0 = time.monotonic()
        bboxes_by_quote = resolve_citation_in_pdf(pdf_bytes, citation.quotes, markdown)
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

    def pdf_loader(doi: str) -> bytes | None:
        try:
            return read_bytes(paper_url(base, doi, 'source.pdf'))
        except FileNotFoundError:
            return None

    def md_loader(doi: str) -> str | None:
        try:
            return read_text(paper_url(base, doi, 'markdown.md'))
        except FileNotFoundError:
            return None

    result = resolve_citations(citations, pdf_loader=pdf_loader, markdown_loader=md_loader)
    json.dump(result.model_dump(), sys.stdout)
    sys.stdout.write('\n')
