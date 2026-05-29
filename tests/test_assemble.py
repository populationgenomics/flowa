"""Tests for `flowa.assemble`.

Uses a local fsspec base (tmp_path) as storage. The xlsx round-trip exercises
real markitdown; the size-policy / ordering / failure paths monkeypatch
`_convert_supplement` so they don't depend on crafting oversized real files.
"""

import io

import openpyxl

from flowa.assemble import PER_SUPPLEMENT_TOKEN_CAP, assemble_paper
from flowa.storage import paper_url, read_text, write_bytes, write_text

DOI = '10.1234/test.paper'


def _xlsx_bytes(rows: list[list[str]]) -> bytes:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = 'Variants'
    for row in rows:
        ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_assemble_no_supplements_copies_source_md(tmp_path) -> None:
    base = str(tmp_path)
    write_text(paper_url(base, DOI, 'source.md'), '# Paper\n\nBody text.')
    assemble_paper(base, DOI)
    # No supplements -> markdown.md is byte-identical to source.md.
    assert read_text(paper_url(base, DOI, 'markdown.md')) == '# Paper\n\nBody text.'


def test_assemble_appends_real_xlsx_with_marker(tmp_path) -> None:
    base = str(tmp_path)
    write_text(paper_url(base, DOI, 'source.md'), '# Paper\n\nBody.')
    write_bytes(
        paper_url(base, DOI, 'supplements/000_variants.xlsx'),
        _xlsx_bytes([['Variant', 'Class'], ['c.1935C>A', 'Pathogenic']]),
    )
    assemble_paper(base, DOI)
    md = read_text(paper_url(base, DOI, 'markdown.md'))
    assert md.startswith('# Paper\n\nBody.')
    assert '<!--supplement: 000_variants.xlsx-->' in md
    assert 'c.1935C>A' in md
    assert '| Variant | Class |' in md  # markitdown emits a GFM table


def test_assemble_orders_supplements_by_ord_prefix(tmp_path, monkeypatch) -> None:
    base = str(tmp_path)
    write_text(paper_url(base, DOI, 'source.md'), 'SRC')
    for name in ('001_b.docx', '000_a.docx'):
        write_bytes(paper_url(base, DOI, f'supplements/{name}'), b'x')
    monkeypatch.setattr('flowa.assemble._convert_supplement', lambda fn, data: f'CONTENT_{fn}')
    assemble_paper(base, DOI)
    md = read_text(paper_url(base, DOI, 'markdown.md'))
    assert md.index('000_a.docx') < md.index('001_b.docx')


def test_assemble_skips_oversized_supplement(tmp_path, monkeypatch) -> None:
    base = str(tmp_path)
    write_text(paper_url(base, DOI, 'source.md'), 'SRC')
    write_bytes(paper_url(base, DOI, 'supplements/000_big.xlsx'), b'x')
    write_bytes(paper_url(base, DOI, 'supplements/001_ok.xlsx'), b'x')
    sizes = {'000_big.xlsx': (PER_SUPPLEMENT_TOKEN_CAP + 1000) * 4, '001_ok.xlsx': 40}
    monkeypatch.setattr('flowa.assemble._convert_supplement', lambda fn, data: 'x' * sizes[fn])
    assemble_paper(base, DOI)
    md = read_text(paper_url(base, DOI, 'markdown.md'))
    assert '000_big.xlsx' not in md  # over per-file cap -> skipped
    assert '<!--supplement: 001_ok.xlsx-->' in md  # the rest still proceed


def test_assemble_stops_at_total_budget(tmp_path, monkeypatch) -> None:
    base = str(tmp_path)
    write_text(paper_url(base, DOI, 'source.md'), 'SRC')
    for name in ('000_a.docx', '001_b.docx', '002_c.docx'):
        write_bytes(paper_url(base, DOI, f'supplements/{name}'), b'x')
    # Each ~28k tokens; the third would push the running total past 80k, so it
    # (and anything after) is skipped entirely.
    per_chars = 28_000 * 4
    monkeypatch.setattr('flowa.assemble._convert_supplement', lambda fn, data: 'x' * per_chars)
    assemble_paper(base, DOI)
    md = read_text(paper_url(base, DOI, 'markdown.md'))
    assert '<!--supplement: 000_a.docx-->' in md
    assert '<!--supplement: 001_b.docx-->' in md
    assert '002_c.docx' not in md


def test_assemble_drops_supplement_on_conversion_failure(tmp_path, monkeypatch) -> None:
    base = str(tmp_path)
    write_text(paper_url(base, DOI, 'source.md'), 'SRC')
    write_bytes(paper_url(base, DOI, 'supplements/000_bad.docx'), b'x')
    write_bytes(paper_url(base, DOI, 'supplements/001_good.docx'), b'x')

    def convert(filename: str, data: bytes) -> str:
        if filename == '000_bad.docx':
            raise ValueError('corrupt')
        return 'GOOD CONTENT'

    monkeypatch.setattr('flowa.assemble._convert_supplement', convert)
    assemble_paper(base, DOI)
    md = read_text(paper_url(base, DOI, 'markdown.md'))
    assert '000_bad.docx' not in md  # failed conversion dropped
    assert '<!--supplement: 001_good.docx-->' in md
    assert 'GOOD CONTENT' in md
