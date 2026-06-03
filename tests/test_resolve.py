"""Tests for the citation resolver.

`PdfIndex` is mocked at the test-fake level — these tests don't depend on real
PDF parsing. The fake's `resolve()` returns 0-indexed pages (matching anchorite's
contract); assertions verify the resolver wraps to 1-indexed `HighlightBbox` at
the boundary. Markdown anchors use a real markdown string through the real
`anchorite.locate_quote_span` — that path has no heavy dependency. The CLI smoke
runs a subprocess against an empty `--base` so both artifacts are missing for
every DOI — exercising stdin/stdout/argparse without a fixture in the repo.
"""

import json
import subprocess
import sys
from pathlib import Path
from typing import ClassVar

import pytest

from flowa.resolve import (
    CitationQuery,
    HighlightBbox,
    MarkdownAnchor,
    resolve_citations,
    resolve_quotes_in_index,
    resolve_quotes_in_paper,
)


class _FakeBbox:
    def __init__(self, top: int, left: int, bottom: int, right: int):
        self.top = top
        self.left = left
        self.bottom = bottom
        self.right = right


class _FakePdfIndex:
    """Test stand-in for anchorite.PdfIndex.

    `resolutions` is a class attribute the test sets per-case: maps quote → list
    of (page, bbox) pairs. Quotes absent from the map resolve to no locations.
    Pages here are **0-indexed** (anchorite's convention) so the resolver's
    boundary wrap to 1-indexed `HighlightBbox` is exercised.
    """

    resolutions: ClassVar[dict[str, list[tuple[int, _FakeBbox]]]] = {}

    def resolve(self, quotes: list[str]) -> dict[str, list[tuple[int, _FakeBbox]]]:
        return {q: type(self).resolutions.get(q, []) for q in quotes}


@pytest.fixture
def fake_index() -> type[_FakePdfIndex]:
    _FakePdfIndex.resolutions = {}
    return _FakePdfIndex


# --- resolve_quotes_in_index (bboxes only) ----------------------------------


def test_resolve_quotes_in_index_short_circuits_on_empty_quotes(fake_index):
    assert resolve_quotes_in_index(fake_index(), []) == {}


def test_resolve_quotes_in_index_returns_entry_per_input_quote_and_wraps_page(fake_index):
    # Mock returns 0-indexed pages (anchorite's contract); resolver must wrap to 1-indexed.
    fake_index.resolutions = {
        'first quote': [(0, _FakeBbox(top=10, left=20, bottom=30, right=40))],
        'third quote': [
            (1, _FakeBbox(top=100, left=200, bottom=300, right=400)),
            (4, _FakeBbox(top=110, left=210, bottom=310, right=410)),
        ],
    }
    quotes = ['first quote', 'second quote', 'third quote']
    result = resolve_quotes_in_index(fake_index(), quotes)

    assert list(result.keys()) == quotes
    assert result['first quote'] == [HighlightBbox(page=1, top=10, left=20, bottom=30, right=40)]
    assert result['third quote'] == [
        HighlightBbox(page=2, top=100, left=200, bottom=300, right=400),
        HighlightBbox(page=5, top=110, left=210, bottom=310, right=410),
    ]
    assert result['second quote'] == []


# --- resolve_quotes_in_paper (bboxes + markdown anchor) ---------------------


def test_resolve_quotes_in_paper_resolves_bboxes_and_markdown_anchor(fake_index):
    markdown = 'Background.\n\nThe patient carried the c.1935C>A variant in GAA.\n'
    fake_index.resolutions = {'patient carried the c.1935C>A': [(0, _FakeBbox(1, 2, 3, 4))]}

    result = resolve_quotes_in_paper(['patient carried the c.1935C>A'], fake_index(), markdown)
    rq = result['patient carried the c.1935C>A']

    assert rq.bboxes == [HighlightBbox(page=1, top=1, left=2, bottom=3, right=4)]
    assert rq.markdown_anchor is not None
    # Offsets are code points into the markdown; round-trip back to the source text.
    assert markdown[rq.markdown_anchor.start : rq.markdown_anchor.end].startswith('patient carried')
    assert 'c.1935C>A' in markdown[rq.markdown_anchor.start : rq.markdown_anchor.end]


def test_resolve_quotes_in_paper_anchor_none_when_quote_absent(fake_index):
    result = resolve_quotes_in_paper(['not present anywhere at all'], fake_index(), 'Totally unrelated prose.')
    rq = result['not present anywhere at all']
    assert rq.bboxes == []
    assert rq.markdown_anchor is None


def test_resolve_quotes_in_paper_no_markdown_means_no_anchor(fake_index):
    fake_index.resolutions = {'quote': [(0, _FakeBbox(1, 2, 3, 4))]}
    result = resolve_quotes_in_paper(['quote'], fake_index(), None)
    rq = result['quote']
    assert rq.bboxes == [HighlightBbox(page=1, top=1, left=2, bottom=3, right=4)]
    assert rq.markdown_anchor is None


def test_resolve_quotes_in_paper_no_pdf_index_means_no_bboxes():
    markdown = 'The variant c.1935C>A was reported.'
    result = resolve_quotes_in_paper(['variant c.1935C>A was reported'], None, markdown)
    rq = result['variant c.1935C>A was reported']
    assert rq.bboxes == []
    assert rq.markdown_anchor is not None


# --- resolve_citations -------------------------------------------------------


def test_resolve_citations_groups_results_per_doi(fake_index):
    fake_index.resolutions = {
        'quote A': [(0, _FakeBbox(top=1, left=2, bottom=3, right=4))],
        'quote B': [(6, _FakeBbox(top=5, left=6, bottom=7, right=8))],
    }
    indices = {'10.1/a': fake_index(), '10.2/b': fake_index()}
    citations = [
        CitationQuery(doi='10.1/a', quotes=['quote A']),
        CitationQuery(doi='10.2/b', quotes=['quote B']),
    ]

    result = resolve_citations(citations, pdf_index_provider=indices.get)

    assert set(result.resolved.keys()) == {'10.1/a', '10.2/b'}
    # Anchorite's 0-indexed page → flowa's 1-indexed wire format. No markdown
    # provider was passed, so anchors are null.
    assert result.resolved['10.1/a']['quote A'].bboxes == [HighlightBbox(page=1, top=1, left=2, bottom=3, right=4)]
    assert result.resolved['10.1/a']['quote A'].markdown_anchor is None
    assert result.resolved['10.2/b']['quote B'].bboxes == [HighlightBbox(page=7, top=5, left=6, bottom=7, right=8)]
    assert result.errors == {}


def test_resolve_citations_resolves_anchors_with_markdown_provider(fake_index):
    markdown_by_doi = {'10.1/a': 'Methods.\n\nWe found the c.1935C>A change in two probands.\n'}
    citations = [CitationQuery(doi='10.1/a', quotes=['found the c.1935C>A change'])]

    result = resolve_citations(
        citations,
        pdf_index_provider=lambda _doi: fake_index(),  # no bboxes configured
        markdown_provider=markdown_by_doi.get,
    )
    rq = result.resolved['10.1/a']['found the c.1935C>A change']
    assert rq.bboxes == []
    assert rq.markdown_anchor is not None
    md = markdown_by_doi['10.1/a']
    assert 'c.1935C>A' in md[rq.markdown_anchor.start : rq.markdown_anchor.end]


def test_resolve_citations_errors_only_when_both_sources_unavailable(fake_index):
    def pdf_provider(doi: str) -> _FakePdfIndex | None:
        return fake_index() if doi == '10.1/a' else None

    fake_index.resolutions = {'quote A': [(0, _FakeBbox(top=1, left=2, bottom=3, right=4))]}

    citations = [
        CitationQuery(doi='10.1/a', quotes=['quote A']),
        CitationQuery(doi='10.missing/x', quotes=['anything']),
    ]
    # No markdown provider → markdown is None everywhere; the missing DOI has
    # neither pdf_index nor markdown, so it errors.
    result = resolve_citations(citations, pdf_index_provider=pdf_provider)

    assert '10.1/a' in result.resolved
    assert '10.missing/x' not in result.resolved
    assert result.errors == {'10.missing/x': 'pdf_index and markdown not available'}


def test_resolve_citations_no_error_when_only_markdown_available(fake_index):
    # pdf_index missing but markdown present → resolved (empty bboxes, real anchor), not an error.
    citations = [CitationQuery(doi='10.1/a', quotes=['the c.1935C>A variant'])]
    result = resolve_citations(
        citations,
        pdf_index_provider=lambda _doi: None,
        markdown_provider=lambda _doi: 'We describe the c.1935C>A variant here.',
    )
    assert result.errors == {}
    rq = result.resolved['10.1/a']['the c.1935C>A variant']
    assert rq.bboxes == []
    assert rq.markdown_anchor is not None


def test_resolve_citations_provider_exceptions_propagate(fake_index):
    def provider(doi: str) -> _FakePdfIndex | None:
        raise RuntimeError('storage backend failed')

    citations = [CitationQuery(doi='10.1/a', quotes=['anything'])]
    with pytest.raises(RuntimeError, match='storage backend failed'):
        resolve_citations(citations, pdf_index_provider=provider)


def test_resolve_citations_handles_empty_input():
    result = resolve_citations([], pdf_index_provider=lambda _doi: pytest.fail('provider should not be called'))
    assert result.resolved == {}
    assert result.errors == {}


def test_markdown_anchor_model_round_trips():
    anchor = MarkdownAnchor(start=12, end=34)
    assert anchor.model_dump() == {'start': 12, 'end': 34}


def test_cli_smoke_returns_errors_for_missing_artifacts(tmp_path: Path):
    """Subprocess `flowa resolve` against an empty --base.

    Both loaders return None for every DOI (no pdf_index.pkl.zst, no assembled markdown),
    so each requested DOI lands in `errors` without crashing — exercising the full
    stdin → JSON out plumbing without a fixture in the repo.
    """
    payload = json.dumps({'citations': [{'doi': '10.1/missing', 'quotes': ['any quote']}]})
    proc = subprocess.run(
        [sys.executable, '-m', 'flowa.cli', 'resolve', '--base', str(tmp_path)],
        input=payload,
        capture_output=True,
        text=True,
        check=True,
    )
    output = json.loads(proc.stdout)
    assert output['resolved'] == {}
    assert output['errors'] == {'10.1/missing': 'pdf_index and markdown not available'}
