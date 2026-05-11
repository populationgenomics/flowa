"""HTTP shape tests for /resolve-citations.

Library-level resolver behaviour is covered in flowa's `tests/test_resolve.py`;
here we just check that the route plumbs Settings → loader → flowa.resolve
correctly and returns the expected wire shape.
"""

from pathlib import Path

from fastapi.testclient import TestClient
from flowa import resolve as flowa_resolve_module
from flowa.storage import encode_doi

from demo_gateway.config import Settings


def _write_fake_paper(data_dir: Path, doi: str, pdf: bytes = b'fake-pdf', markdown: str = '# fake md') -> None:
    paper_dir = data_dir / 'papers' / encode_doi(doi)
    paper_dir.mkdir(parents=True, exist_ok=True)
    (paper_dir / 'source.pdf').write_bytes(pdf)
    (paper_dir / 'markdown.md').write_text(markdown)


def test_post_resolve_citations_rejects_malformed_body(client: TestClient) -> None:
    response = client.post('/resolve-citations', json={'oops': []})
    assert response.status_code == 422


def test_post_resolve_citations_returns_errors_for_missing_pdfs(client: TestClient) -> None:
    """When source.pdf is absent, the DOI surfaces in `errors` rather than `resolved`."""
    response = client.post(
        '/resolve-citations',
        json={'citations': [{'doi': '10.1/missing', 'quotes': ['anything']}]},
    )
    assert response.status_code == 200
    body = response.json()
    assert body['resolved'] == {}
    assert body['errors'] == {'10.1/missing': 'source.pdf not found'}


def test_post_resolve_citations_returns_resolved_bboxes(
    client: TestClient,
    settings: Settings,
    monkeypatch,
) -> None:
    """When source.pdf exists, the route resolves quotes to bboxes via the library."""

    class _FakeBbox:
        def __init__(self, top: int, left: int, bottom: int, right: int) -> None:
            self.top = top
            self.left = left
            self.bottom = bottom
            self.right = right

    class _FakePdfIndex:
        def __init__(self, _pdf_bytes: bytes, *, markdown: str | None = None) -> None:
            pass

        def resolve(self, quotes: list[str]) -> dict[str, list[tuple[int, _FakeBbox]]]:
            # 0-indexed page from anchorite — the +1 boundary wrap in resolve.py
            # turns this into page=1 on the wire.
            return {q: [(0, _FakeBbox(top=10, left=20, bottom=30, right=40))] for q in quotes}

    monkeypatch.setattr(flowa_resolve_module, 'PdfIndex', _FakePdfIndex)
    _write_fake_paper(settings.demo_data_dir, '10.1/present')

    response = client.post(
        '/resolve-citations',
        json={'citations': [{'doi': '10.1/present', 'quotes': ['some quote']}]},
    )
    assert response.status_code == 200
    body = response.json()
    assert body['errors'] == {}
    assert body['resolved'] == {
        '10.1/present': {
            'some quote': [{'page': 1, 'top': 10, 'left': 20, 'bottom': 30, 'right': 40}],
        },
    }
