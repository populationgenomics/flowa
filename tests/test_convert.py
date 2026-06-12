"""Tests for `flowa.convert`: per-piece transcription caching, the merged.pdf build,
the page-cap, and the assemble cascade.

`transcribe()` and the PdfIndex build are monkeypatched so the tests are deterministic
and never touch Bedrock; `concatenate_pdfs` / the page-cap run for real on tiny
pypdf-generated PDFs. The fake transcribe returns ``"T{n}"`` for an n-page PDF and
records each call's page count, so we can assert exactly which PDFs were transcribed.
"""

import io

from pypdf import PdfReader, PdfWriter

import flowa.convert as convert
from flowa.convert import _accept_pdf_supplements, _concatenate_pdfs, convert_paper_async
from flowa.settings import ModelConfig
from flowa.storage import exists, full_md_url, full_pdf_url, paper_url, read_bytes, read_text, remove, write_bytes

DOI = '10.1234/test.paper'
MODEL = ModelConfig(name='test-model')  # opaque here; transcribe is monkeypatched


def _pdf(n_pages: int) -> bytes:
    writer = PdfWriter()
    for _ in range(n_pages):
        writer.add_blank_page(width=72, height=72)
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


def _pages(data: bytes) -> int:
    return len(PdfReader(io.BytesIO(data)).pages)


def _patch(monkeypatch) -> list[int]:
    """Patch transcribe / prompt / index build. Returns the list of transcribed page counts."""
    calls: list[int] = []

    async def fake_transcribe(pdf_bytes, *, model, prompt, page_count=None):
        pages = _pages(pdf_bytes)
        calls.append(pages)
        return convert.ConvertResult(markdown=f'T{pages}', all_messages=[])

    monkeypatch.setattr('flowa.convert.transcribe', fake_transcribe)
    monkeypatch.setattr('flowa.convert.load_text_prompt', lambda step, prompt_set: 'PROMPT')
    monkeypatch.setattr('flowa.convert.build_pdf_index_payload', lambda *a, **k: None)
    monkeypatch.setattr('flowa.convert.serialize_pdf_index_payload', lambda *a, **k: b'INDEX')
    return calls


# --- pure helpers ---------------------------------------------------------------


def test_concatenate_pdfs_sums_pages() -> None:
    assert _pages(_concatenate_pdfs([_pdf(2), _pdf(3)])) == 5


def test_accept_pdf_supplements_per_file_cap() -> None:
    accepted = _accept_pdf_supplements([('a.pdf', _pdf(5)), ('big.pdf', _pdf(25)), ('c.pdf', _pdf(5))])
    assert [n for n, _ in accepted] == ['a.pdf', 'c.pdf']  # the 25-page file is over the 20 cap


def test_accept_pdf_supplements_total_budget() -> None:
    supps = [(f'{i}.pdf', _pdf(20)) for i in range(4)]  # 20 each; 50-page total budget
    accepted = _accept_pdf_supplements(supps)
    assert [n for n, _ in accepted] == ['0.pdf', '1.pdf']  # 20+20 ok; +20 would exceed 50


def test_accept_pdf_supplements_drops_unreadable() -> None:
    accepted = _accept_pdf_supplements([('bad.pdf', b'not a pdf'), ('ok.pdf', _pdf(1))])
    assert [n for n, _ in accepted] == ['ok.pdf']


# --- convert_paper_async --------------------------------------------------------


async def test_convert_no_supplements(tmp_path, monkeypatch) -> None:
    base = str(tmp_path)
    calls = _patch(monkeypatch)
    write_bytes(paper_url(base, DOI, 'main.pdf'), _pdf(2))

    await convert_paper_async(base, DOI, MODEL)

    assert calls == [2]
    assert read_text(paper_url(base, DOI, 'main.md')) == 'T2'
    assert not exists(paper_url(base, DOI, 'merged.md'))  # no supplements -> no merged.md
    assert full_md_url(base, DOI).endswith('/main.md')  # consumers read main.md
    assert exists(paper_url(base, DOI, 'pdf_index.pkl.zst'))
    assert not exists(paper_url(base, DOI, 'merged.pdf'))
    assert full_pdf_url(base, DOI).endswith('/main.pdf')


async def test_convert_with_pdf_supplement_builds_merge(tmp_path, monkeypatch) -> None:
    base = str(tmp_path)
    _patch(monkeypatch)
    write_bytes(paper_url(base, DOI, 'main.pdf'), _pdf(2))
    write_bytes(paper_url(base, DOI, 'supplements/000_s1.pdf'), _pdf(1))

    await convert_paper_async(base, DOI, MODEL)

    assert _pages(read_bytes(paper_url(base, DOI, 'merged.pdf'))) == 3  # 2 main + 1 supplement
    assert full_pdf_url(base, DOI).endswith('/merged.pdf')
    assert read_text(paper_url(base, DOI, 'supplements/000_s1.pdf.md')) == 'T1'
    assert full_md_url(base, DOI).endswith('/merged.md')
    md = read_text(paper_url(base, DOI, 'merged.md'))
    assert md.startswith('T2')
    assert '<!--supplement: 000_s1.pdf-->' in md
    assert 'T1' in md


async def test_convert_is_incremental_per_supplement(tmp_path, monkeypatch) -> None:
    base = str(tmp_path)
    calls = _patch(monkeypatch)
    write_bytes(paper_url(base, DOI, 'main.pdf'), _pdf(2))
    write_bytes(paper_url(base, DOI, 'supplements/000_s1.pdf'), _pdf(1))
    await convert_paper_async(base, DOI, MODEL)
    assert sorted(calls) == [1, 2]  # main + first supplement

    # Add a second supplement; mimic the PDF-supplement invalidation (drop merged.pdf +
    # index + merged.md, keep main.md and the existing sidecar).
    calls.clear()
    for f in ('merged.pdf', 'pdf_index.pkl.zst', 'merged.md'):
        remove(paper_url(base, DOI, f))
    write_bytes(paper_url(base, DOI, 'supplements/001_s2.pdf'), _pdf(3))

    await convert_paper_async(base, DOI, MODEL)

    assert calls == [3]  # only the new supplement is transcribed
    assert _pages(read_bytes(paper_url(base, DOI, 'merged.pdf'))) == 6  # 2 + 1 + 3
    md = read_text(paper_url(base, DOI, 'merged.md'))
    assert '<!--supplement: 000_s1.pdf-->' in md
    assert '<!--supplement: 001_s2.pdf-->' in md


async def test_convert_cached_is_noop(tmp_path, monkeypatch) -> None:
    base = str(tmp_path)
    calls = _patch(monkeypatch)
    write_bytes(paper_url(base, DOI, 'main.pdf'), _pdf(1))
    await convert_paper_async(base, DOI, MODEL)
    calls.clear()

    await convert_paper_async(base, DOI, MODEL)

    assert calls == []  # fast path: all derived artifacts present


async def test_convert_page_cap_drops_oversized_supplement(tmp_path, monkeypatch) -> None:
    base = str(tmp_path)
    _patch(monkeypatch)
    write_bytes(paper_url(base, DOI, 'main.pdf'), _pdf(1))
    write_bytes(paper_url(base, DOI, 'supplements/000_big.pdf'), _pdf(25))  # over the 20 cap

    await convert_paper_async(base, DOI, MODEL)

    assert not exists(paper_url(base, DOI, 'supplements/000_big.pdf.md'))  # never transcribed
    assert not exists(paper_url(base, DOI, 'merged.pdf'))  # nothing accepted -> no merge
    assert not exists(paper_url(base, DOI, 'merged.md'))  # no content -> no merged.md
    assert read_text(full_md_url(base, DOI)) == 'T1'  # full_md falls back to main.md


async def test_convert_drops_stale_merge_when_last_supplement_removed(tmp_path, monkeypatch) -> None:
    base = str(tmp_path)
    _patch(monkeypatch)
    write_bytes(paper_url(base, DOI, 'main.pdf'), _pdf(1))
    write_bytes(paper_url(base, DOI, 'supplements/000_s1.pdf'), _pdf(1))
    await convert_paper_async(base, DOI, MODEL)
    assert exists(paper_url(base, DOI, 'merged.pdf'))

    # Remove the supplement + its sidecar + index + merged.md, but leave merged.pdf:
    # convert must self-heal by dropping the now-stale merge.
    for f in ('supplements/000_s1.pdf', 'supplements/000_s1.pdf.md', 'pdf_index.pkl.zst', 'merged.md'):
        remove(paper_url(base, DOI, f))

    await convert_paper_async(base, DOI, MODEL)

    assert not exists(paper_url(base, DOI, 'merged.pdf'))
    assert full_pdf_url(base, DOI).endswith('/main.pdf')
    assert not exists(paper_url(base, DOI, 'merged.md'))  # back to main-only
    assert read_text(full_md_url(base, DOI)) == 'T1'
