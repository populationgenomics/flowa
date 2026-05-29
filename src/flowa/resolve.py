"""Citation-bbox resolver: align verbatim quotes to PDF page+bbox locations.

The resolver doesn't construct `PdfIndex` objects itself. Construction
dominates per-call latency (~8s on the deployed gateway hardware against
~300ms for the actual alignment), so every paper carries a pre-built
`pdf_index.pkl.zst` next to its `source.pdf` — written by `flowa.convert`
when the paper is first transcribed, and persisted in storage thereafter.
Callers supply an `pdf_index_provider` that loads the pickle for a given DOI.

Wire-format types (`CitationQuery`, `HighlightBbox`, `ResolvedCitations`,
`ResolveRequest`) are the canonical Pydantic shapes shared with HTTP consumers.
"""

import json
import logging
import sys
import time
from collections.abc import Callable

import typer
from anchorite import PdfIndex, locate_quote_span
from pydantic import BaseModel, Field

from flowa.pdf_index_cache import deserialize as deserialize_pdf_index_payload
from flowa.storage import exists, paper_url, read_bytes, read_text

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


class MarkdownAnchor(BaseModel):
    """A half-open ``[start, end)`` range into the paper's markdown.md, in
    Unicode code points — Python ``str`` indices, exactly what
    ``anchorite.locate_quote_span`` returns and passed through unchanged.
    """

    start: int
    end: int


class ResolvedQuote(BaseModel):
    """Where a quote lands in a paper: PDF bboxes and/or a markdown.md char span.

    `bboxes` is empty when the quote couldn't be aligned in the PDF (or no
    `PdfIndex` was available); `markdown_anchor` is null when it couldn't be
    located in markdown.md (or no markdown.md was available).
    """

    bboxes: list[HighlightBbox] = Field(default_factory=list)
    markdown_anchor: MarkdownAnchor | None = None


class ResolvedCitations(BaseModel):
    """Output: a `ResolvedQuote` per (DOI, quote) plus per-DOI fetch errors.

    `resolved[doi][quote]` carries the quote's PDF bboxes and markdown anchor. A
    DOI whose `PdfIndex` and markdown.md are *both* unavailable is absent from
    `resolved` and surfaces in `errors` — consumers distinguish "paper artifacts
    unavailable" from "quote not found" (empty bboxes + null anchor).
    """

    resolved: dict[str, dict[str, ResolvedQuote]] = Field(default_factory=dict)
    errors: dict[str, str] = Field(default_factory=dict)


class ResolveRequest(BaseModel):
    """HTTP request wrapper used by demo-gateway and other HTTP consumers."""

    citations: list[CitationQuery]


# --- Resolver ---------------------------------------------------------------

PdfIndexProvider = Callable[[str], PdfIndex | None]
MarkdownProvider = Callable[[str], str | None]


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


def resolve_quotes_in_paper(
    quotes: list[str],
    pdf_index: PdfIndex | None,
    markdown: str | None,
) -> dict[str, ResolvedQuote]:
    """Resolve each quote to PDF bboxes (via `pdf_index`) and a markdown anchor
    (via `anchorite.locate_quote_span` over `markdown`). Pure — no I/O.

    Either source may be absent: with no `pdf_index`, bboxes are empty; with no
    `markdown`, the anchor is null. Returns one `ResolvedQuote` per input quote.
    """
    bboxes_by_quote = resolve_quotes_in_index(pdf_index, quotes) if pdf_index is not None else {}
    resolved: dict[str, ResolvedQuote] = {}
    for quote in quotes:
        anchor: MarkdownAnchor | None = None
        if markdown is not None:
            span = locate_quote_span(markdown, quote)
            if span is not None:
                # locate_quote_span returns Unicode code-point offsets; passed
                # through as-is (MarkdownAnchor's documented unit).
                anchor = MarkdownAnchor(start=span[0], end=span[1])
        resolved[quote] = ResolvedQuote(bboxes=bboxes_by_quote.get(quote, []), markdown_anchor=anchor)
    return resolved


def resolve_citations(
    citations: list[CitationQuery],
    pdf_index_provider: PdfIndexProvider,
    markdown_provider: MarkdownProvider | None = None,
) -> ResolvedCitations:
    """Resolve quote → bbox + markdown-anchor mappings for a batch of (DOI, quotes).

    `pdf_index_provider(doi)` returns a `PdfIndex` (or None); `markdown_provider(doi)`
    returns the paper's markdown.md text (or None). Omit `markdown_provider` to
    skip anchor resolution (bboxes only). A DOI whose `PdfIndex` and markdown.md
    are both unavailable is surfaced as a per-DOI error in `result.errors`.
    Provider exceptions propagate.
    """
    resolved: dict[str, dict[str, ResolvedQuote]] = {}
    errors: dict[str, str] = {}
    total_start = time.monotonic()

    for citation in citations:
        pdf_index = pdf_index_provider(citation.doi)
        markdown = markdown_provider(citation.doi) if markdown_provider is not None else None
        if pdf_index is None and markdown is None:
            log.warning('Neither pdf_index nor markdown.md available for %s', citation.doi)
            errors[citation.doi] = 'pdf_index and markdown.md not available'
            continue
        t0 = time.monotonic()
        quotes = resolve_quotes_in_paper(citation.quotes, pdf_index, markdown)
        elapsed = time.monotonic() - t0
        located = sum(1 for q in citation.quotes if quotes[q].bboxes or quotes[q].markdown_anchor)
        log.info('Resolved %s: %d/%d quotes in %.1fs', citation.doi, located, len(citation.quotes), elapsed)
        resolved[citation.doi] = quotes

    total_elapsed = time.monotonic() - total_start
    total_quotes = sum(len(c.quotes) for c in citations)
    total_located = sum(
        1
        for c in citations
        for q in c.quotes
        if (rq := resolved.get(c.doi, {}).get(q)) is not None and (rq.bboxes or rq.markdown_anchor)
    )
    log.info(
        'Citation resolution complete: %d/%d quotes across %d papers in %.1fs',
        total_located,
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


def load_markdown_from_storage(base: str, doi: str) -> str | None:
    """Read `papers/{doi}/markdown.md` from a flowa storage base, or None if absent.

    The consumer-facing assembled artifact (source.md + converted supplements).
    `resolve_citations` normalises it on demand via `anchorite.locate_quote_span`;
    there is no persisted markdown index to load.
    """
    md_url = paper_url(base, doi, 'markdown.md')
    if not exists(md_url):
        return None
    return read_text(md_url)


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
    """Resolve citation quotes to PDF bounding boxes and markdown.md anchors.

    Reads `{ "citations": [ { "doi": "...", "quotes": ["..."] } ] }` from stdin.
    Writes `{ "resolved": {...}, "errors": {...} }` to stdout.

    DOIs whose `pdf_index.pkl.zst` and `markdown.md` are both missing from
    storage surface in `errors` rather than rebuilding on the fly — run
    `flowa convert` to produce the artifacts.
    """
    payload = json.load(sys.stdin)
    citations = [CitationQuery.model_validate(c) for c in payload['citations']]
    result = resolve_citations(
        citations,
        pdf_index_provider=lambda doi: load_pdf_index_from_storage(base, doi),
        markdown_provider=lambda doi: load_markdown_from_storage(base, doi),
    )
    json.dump(result.model_dump(), sys.stdout)
    sys.stdout.write('\n')
