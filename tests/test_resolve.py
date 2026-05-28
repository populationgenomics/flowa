"""Tests for the citation-bbox resolver.

`PdfIndex` is mocked at the test-fake level — these tests don't depend on
real PDF parsing. The fake's `resolve()` returns 0-indexed pages (matching
anchorite's contract); assertions verify the resolver wraps to 1-indexed
`HighlightBbox` at the boundary. The CLI smoke uses a subprocess against
an empty `--base` so `load_pdf_index_from_storage` returns None for every
DOI — exercises stdin/stdout/argparse without needing a fixture pickle in
the repo.
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
    resolve_citations,
    resolve_quotes_in_index,
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


def test_resolve_quotes_in_index_short_circuits_on_empty_quotes(fake_index):
    result = resolve_quotes_in_index(fake_index(), [])
    assert result == {}


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

    # Every input quote appears, in input order.
    assert list(result.keys()) == quotes
    assert result['first quote'] == [HighlightBbox(page=1, top=10, left=20, bottom=30, right=40)]
    assert result['third quote'] == [
        HighlightBbox(page=2, top=100, left=200, bottom=300, right=400),
        HighlightBbox(page=5, top=110, left=210, bottom=310, right=410),
    ]
    # Unlocated quote gets empty list (distinct from "DOI absent" at the resolve_citations layer).
    assert result['second quote'] == []


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

    result = resolve_citations(citations, index_provider=indices.get)

    assert set(result.resolved.keys()) == {'10.1/a', '10.2/b'}
    # Anchorite's 0-indexed page → flowa's 1-indexed wire format.
    assert result.resolved['10.1/a']['quote A'] == [HighlightBbox(page=1, top=1, left=2, bottom=3, right=4)]
    assert result.resolved['10.2/b']['quote B'] == [HighlightBbox(page=7, top=5, left=6, bottom=7, right=8)]
    assert result.errors == {}


def test_resolve_citations_records_errors_when_index_provider_returns_none(fake_index):
    def provider(doi: str) -> _FakePdfIndex | None:
        return fake_index() if doi == '10.1/a' else None

    fake_index.resolutions = {'quote A': [(0, _FakeBbox(top=1, left=2, bottom=3, right=4))]}

    citations = [
        CitationQuery(doi='10.1/a', quotes=['quote A']),
        CitationQuery(doi='10.missing/x', quotes=['anything']),
    ]
    result = resolve_citations(citations, index_provider=provider)

    # Successful DOI is in `resolved`; missing DOI is in `errors` (never in `resolved`).
    assert '10.1/a' in result.resolved
    assert '10.missing/x' not in result.resolved
    assert result.errors == {'10.missing/x': 'pdf_index not available'}


def test_resolve_citations_provider_exceptions_propagate(fake_index):
    def provider(doi: str) -> _FakePdfIndex | None:
        raise RuntimeError('storage backend failed')

    citations = [CitationQuery(doi='10.1/a', quotes=['anything'])]

    with pytest.raises(RuntimeError, match='storage backend failed'):
        resolve_citations(citations, index_provider=provider)


def test_resolve_citations_handles_empty_input(fake_index):
    # Edge case: empty citations list. No provider calls, no resolutions.
    result = resolve_citations([], index_provider=lambda _doi: pytest.fail('provider should not be called'))
    assert result.resolved == {}
    assert result.errors == {}


def test_cli_smoke_returns_errors_for_missing_index(tmp_path: Path):
    """Subprocess call to `flowa resolve` against an empty --base.

    The loader returns None for every DOI (no pdf_index.pkl.zst exists),
    which should populate `errors` for each requested DOI without crashing.
    Exercises the full stdin → JSON out plumbing without needing a real
    fixture in the repo.
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
    assert output['errors'] == {'10.1/missing': 'pdf_index not available'}
