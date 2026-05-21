"""Tests for the citation-bbox resolver.

anchorite's `PdfIndex` is mocked at the resolve-module level so the tests
exercise the resolver's plumbing (quote ordering, bbox normalisation, loader
failure paths, page-index boundary wrap, aggregate logging counts) without
depending on real PDF parsing. The CLI smoke uses a subprocess against an
empty `--base` so the loader returns None for every DOI — exercises
stdin/stdout/argparse without needing a fixture PDF in the repo.

Mocks return **0-indexed** pages (matching anchorite's contract); assertions
then verify the resolver wraps to 1-indexed `HighlightBbox` at the boundary.
"""

import json
import subprocess
import sys
from pathlib import Path
from typing import ClassVar

import pytest

from flowa import resolve as resolve_module
from flowa.resolve import (
    CitationQuery,
    HighlightBbox,
    resolve_citation_in_pdf,
    resolve_citations,
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
    constructed_with: ClassVar[list[tuple[bytes, str | None]]] = []

    def __init__(self, pdf_bytes: bytes, *, markdown: str | None = None):
        type(self).constructed_with.append((pdf_bytes, markdown))

    def resolve(self, quotes: list[str]) -> dict[str, list[tuple[int, _FakeBbox]]]:
        return {q: type(self).resolutions.get(q, []) for q in quotes}


@pytest.fixture
def fake_pdf_index(monkeypatch):
    _FakePdfIndex.resolutions = {}
    _FakePdfIndex.constructed_with = []
    monkeypatch.setattr(resolve_module, 'PdfIndex', _FakePdfIndex)
    return _FakePdfIndex


def test_resolve_citation_in_pdf_short_circuits_on_empty_quotes(fake_pdf_index):
    result = resolve_citation_in_pdf(b'pdf-bytes', [], markdown='# md')
    assert result == {}
    # No PdfIndex constructed — avoids paying the parse cost when there's nothing to align.
    assert fake_pdf_index.constructed_with == []


def test_resolve_citation_in_pdf_returns_entry_per_input_quote_and_wraps_page(fake_pdf_index):
    # Mock returns 0-indexed pages (anchorite's contract); resolver must wrap to 1-indexed.
    fake_pdf_index.resolutions = {
        'first quote': [(0, _FakeBbox(top=10, left=20, bottom=30, right=40))],
        'third quote': [
            (1, _FakeBbox(top=100, left=200, bottom=300, right=400)),
            (4, _FakeBbox(top=110, left=210, bottom=310, right=410)),
        ],
    }
    quotes = ['first quote', 'second quote', 'third quote']
    result = resolve_citation_in_pdf(b'pdf-bytes', quotes, markdown='# md')

    # Every input quote appears, in input order.
    assert list(result.keys()) == quotes
    # Located quotes get their normalised HighlightBbox shape — pages are now 1-indexed.
    assert result['first quote'] == [HighlightBbox(page=1, top=10, left=20, bottom=30, right=40)]
    assert result['third quote'] == [
        HighlightBbox(page=2, top=100, left=200, bottom=300, right=400),
        HighlightBbox(page=5, top=110, left=210, bottom=310, right=410),
    ]
    # Unlocated quote gets empty list (distinct from "DOI absent" at the resolve_citations layer).
    assert result['second quote'] == []
    # Markdown is currently NOT passed through to PdfIndex — anchorite's
    # markdown-aware denoise drops entire pages of atoms when the markdown
    # reorders content relative to PDF page order. The caller still plumbs
    # markdown through to resolve_citation_in_pdf so the wiring is in place
    # for the eventual revert. Update this assertion back to '# md' when the
    # anchorite-side fix lands.
    assert fake_pdf_index.constructed_with == [(b'pdf-bytes', None)]


def test_resolve_citations_groups_results_per_doi(fake_pdf_index):
    fake_pdf_index.resolutions = {
        'quote A': [(0, _FakeBbox(top=1, left=2, bottom=3, right=4))],
        'quote B': [(6, _FakeBbox(top=5, left=6, bottom=7, right=8))],
    }
    pdfs = {'10.1/a': b'pdf-A', '10.2/b': b'pdf-B'}
    mds = {'10.1/a': '# md-A', '10.2/b': '# md-B'}
    citations = [
        CitationQuery(doi='10.1/a', quotes=['quote A']),
        CitationQuery(doi='10.2/b', quotes=['quote B']),
    ]

    result = resolve_citations(citations, pdf_loader=pdfs.get, markdown_loader=mds.get)

    assert set(result.resolved.keys()) == {'10.1/a', '10.2/b'}
    # Anchorite's 0-indexed page → flowa's 1-indexed wire format.
    assert result.resolved['10.1/a']['quote A'] == [HighlightBbox(page=1, top=1, left=2, bottom=3, right=4)]
    assert result.resolved['10.2/b']['quote B'] == [HighlightBbox(page=7, top=5, left=6, bottom=7, right=8)]
    assert result.errors == {}
    # Each DOI's PDF was loaded once (no double-fetch). Markdown is currently
    # not forwarded to PdfIndex (see test_resolve_citation_in_pdf_returns_entry_per_input_quote_and_wraps_page).
    assert sorted(fake_pdf_index.constructed_with) == [(b'pdf-A', None), (b'pdf-B', None)]


def test_resolve_citations_records_errors_when_pdf_loader_returns_none(fake_pdf_index):
    def pdf_loader(doi: str) -> bytes | None:
        return b'pdf-A' if doi == '10.1/a' else None

    fake_pdf_index.resolutions = {'quote A': [(0, _FakeBbox(top=1, left=2, bottom=3, right=4))]}

    citations = [
        CitationQuery(doi='10.1/a', quotes=['quote A']),
        CitationQuery(doi='10.missing/x', quotes=['anything']),
    ]
    result = resolve_citations(
        citations,
        pdf_loader=pdf_loader,
        markdown_loader=lambda _doi: '# md',
    )

    # Successful DOI is in `resolved`; missing DOI is in `errors` (never in `resolved`).
    assert '10.1/a' in result.resolved
    assert '10.missing/x' not in result.resolved
    assert result.errors == {'10.missing/x': 'source.pdf not found'}


def test_resolve_citations_records_errors_when_markdown_loader_returns_none(fake_pdf_index):
    # source.pdf is present but markdown.md isn't — storage-invariant violation.
    def md_loader(doi: str) -> str | None:
        return '# md' if doi == '10.1/a' else None

    fake_pdf_index.resolutions = {'quote A': [(0, _FakeBbox(top=1, left=2, bottom=3, right=4))]}

    citations = [
        CitationQuery(doi='10.1/a', quotes=['quote A']),
        CitationQuery(doi='10.2/b', quotes=['quote B']),
    ]
    pdfs = {'10.1/a': b'pdf-A', '10.2/b': b'pdf-B'}
    result = resolve_citations(citations, pdf_loader=pdfs.get, markdown_loader=md_loader)

    assert '10.1/a' in result.resolved
    assert '10.2/b' not in result.resolved
    assert result.errors == {'10.2/b': 'markdown.md not found'}


def test_resolve_citations_loader_exceptions_propagate(fake_pdf_index):
    def pdf_loader(doi: str) -> bytes | None:
        raise RuntimeError('storage backend failed')

    citations = [CitationQuery(doi='10.1/a', quotes=['anything'])]

    with pytest.raises(RuntimeError, match='storage backend failed'):
        resolve_citations(citations, pdf_loader=pdf_loader, markdown_loader=lambda _doi: '# md')


def test_resolve_citations_handles_empty_input(fake_pdf_index):
    # Edge case: empty citations list. No loader calls, no resolutions.
    result = resolve_citations(
        [],
        pdf_loader=lambda _doi: pytest.fail('pdf loader should not be called'),
        markdown_loader=lambda _doi: pytest.fail('markdown loader should not be called'),
    )
    assert result.resolved == {}
    assert result.errors == {}


def test_cli_smoke_returns_errors_for_missing_pdf(tmp_path: Path):
    """Subprocess call to `flowa resolve` against an empty --base.

    The loader's FileNotFoundError → None path should populate `errors` for every
    requested DOI without crashing. Exercises the full stdin → JSON out plumbing
    without needing a real PDF in the repo.
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
    assert output['errors'] == {'10.1/missing': 'source.pdf not found'}
