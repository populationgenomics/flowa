"""HTTP shape tests for /resolve-citations.

Library-level resolver behaviour is covered in flowa's `tests/test_resolve.py`;
here we just check that the route plumbs Settings → pdf_index_provider +
markdown_provider → flowa.resolve correctly and returns the expected wire shape.
"""

from fastapi.testclient import TestClient

import demo_gateway.main as demo_main


def test_post_resolve_citations_rejects_malformed_body(client: TestClient) -> None:
    response = client.post('/resolve-citations', json={'oops': []})
    assert response.status_code == 422


def test_post_resolve_citations_returns_errors_for_missing_sources(client: TestClient) -> None:
    """When both pdf_index.pkl.zst and markdown.md are absent, the DOI surfaces
    in `errors` rather than `resolved`."""
    response = client.post(
        '/resolve-citations',
        json={'citations': [{'doi': '10.1/missing', 'quotes': ['anything']}]},
    )
    assert response.status_code == 200
    body = response.json()
    assert body['resolved'] == {}
    assert body['errors'] == {'10.1/missing': 'pdf_index and markdown.md not available'}


def test_post_resolve_citations_returns_resolved_bboxes(client: TestClient, monkeypatch) -> None:
    """When the index loads, the route resolves quotes to bboxes via the library."""

    class _FakeBbox:
        def __init__(self, top: int, left: int, bottom: int, right: int) -> None:
            self.top = top
            self.left = left
            self.bottom = bottom
            self.right = right

    class _FakePdfIndex:
        def resolve(self, quotes: list[str]) -> dict[str, list[tuple[int, _FakeBbox]]]:
            # 0-indexed page from anchorite — the +1 boundary wrap in resolve.py
            # turns this into page=1 on the wire.
            return {q: [(0, _FakeBbox(top=10, left=20, bottom=30, right=40))] for q in quotes}

    monkeypatch.setattr(
        demo_main,
        'load_pdf_index_from_storage',
        lambda _base, doi: _FakePdfIndex() if doi == '10.1/present' else None,
    )

    # No markdown.md in the tmp data dir, so the anchor is null; the route still
    # resolves bboxes from the (stubbed) PdfIndex.
    response = client.post(
        '/resolve-citations',
        json={'citations': [{'doi': '10.1/present', 'quotes': ['some quote']}]},
    )
    assert response.status_code == 200
    body = response.json()
    assert body['errors'] == {}
    assert body['resolved'] == {
        '10.1/present': {
            'some quote': {
                'bboxes': [{'page': 1, 'top': 10, 'left': 20, 'bottom': 30, 'right': 40}],
                'markdown_anchor': None,
            },
        },
    }


def test_post_resolve_citations_resolves_markdown_anchor(client: TestClient, monkeypatch) -> None:
    """When markdown.md is available (and no PdfIndex), the route attaches a
    markdown_anchor span and leaves bboxes empty — verifying markdown_provider
    is plumbed through to flowa.resolve."""
    markdown = 'Supplementary methods.\n\nThe proband carried the c.1935C>A variant in GAA.\n'
    target = 'proband carried the c.1935C>A variant'
    monkeypatch.setattr(demo_main, 'load_pdf_index_from_storage', lambda _base, _doi: None)
    monkeypatch.setattr(
        demo_main,
        'load_markdown_from_storage',
        lambda _base, doi: markdown if doi == '10.1/md' else None,
    )

    response = client.post(
        '/resolve-citations',
        json={'citations': [{'doi': '10.1/md', 'quotes': [target]}]},
    )
    assert response.status_code == 200
    body = response.json()
    assert body['errors'] == {}
    quote = body['resolved']['10.1/md'][target]
    assert quote['bboxes'] == []
    anchor = quote['markdown_anchor']
    assert anchor is not None
    # The span indexes back into markdown.md by code-point offsets onto the quote region.
    assert 'c.1935C>A' in markdown[anchor['start'] : anchor['end']]
