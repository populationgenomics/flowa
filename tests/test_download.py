"""Unit tests for `flowa.download`.

The PMC/S3 fetch itself is exercised end-to-end by the demo runbook; these cover
the deterministic partitioning and filename-sanitisation logic, plus
`download_paper_async`'s storage layout (main.pdf + ord-prefixed supplements) with
the network fetch monkeypatched.
"""

from flowa.download import _partition_media_urls, _sanitize_supplement_filename, download_paper_async
from flowa.storage import paper_url, read_bytes, write_bytes, write_json

DOI = '10.1234/dl.test'


def test_partition_media_urls_splits_by_extension() -> None:
    media = [
        's3://pmc-oa-opendata/PMC1.1/main_supp.pdf?md5=a',
        's3://pmc-oa-opendata/PMC1.1/table_s1.xlsx',
        's3://pmc-oa-opendata/PMC1.1/methods.docx',
        's3://pmc-oa-opendata/PMC1.1/legacy.doc',  # legacy OLE Word -> dropped
        's3://pmc-oa-opendata/PMC1.1/data.xls',
        's3://pmc-oa-opendata/PMC1.1/figure1.png',  # image -> dropped
        's3://pmc-oa-opendata/PMC1.1/UPPER.XLSX?x=1',  # case-insensitive + query string
    ]
    pdf_urls, office_urls = _partition_media_urls(media)
    assert pdf_urls == ['s3://pmc-oa-opendata/PMC1.1/main_supp.pdf?md5=a']
    assert office_urls == [
        's3://pmc-oa-opendata/PMC1.1/table_s1.xlsx',
        's3://pmc-oa-opendata/PMC1.1/methods.docx',
        's3://pmc-oa-opendata/PMC1.1/data.xls',
        's3://pmc-oa-opendata/PMC1.1/UPPER.XLSX?x=1',
    ]


def test_partition_media_urls_preserves_media_order() -> None:
    # ord prefixes are assigned from this order downstream, so it must be stable.
    media = ['a.docx', 'b.xlsx', 'c.docx']
    _, office_urls = _partition_media_urls(media)
    assert office_urls == ['a.docx', 'b.xlsx', 'c.docx']


def test_partition_media_urls_empty() -> None:
    assert _partition_media_urls([]) == ([], [])


def test_sanitize_supplement_filename_replaces_unsafe_chars() -> None:
    assert _sanitize_supplement_filename('Table S1 (final).xlsx') == 'Table_S1__final_.xlsx'
    # Path separators collapse to underscores — the result is always a basename.
    assert _sanitize_supplement_filename('weird/../path.docx') == 'weird_.._path.docx'


def test_sanitize_supplement_filename_truncates_to_128() -> None:
    out = _sanitize_supplement_filename('a' * 200 + '.xlsx')
    assert len(out) == 128


async def test_download_writes_main_pdf_and_ord_prefixed_supplements(tmp_path, monkeypatch) -> None:
    base = str(tmp_path)
    write_json(paper_url(base, DOI, 'metadata.json'), {'pmid': 42})

    async def fake_fetch(pmid, client, email, tool):
        assert pmid == 42
        # PDF supplement first, then office — exactly fetch_pmc_paper's contract.
        return b'MAINPDF', [('Fig S1.pdf', b'PDFSUP'), ('table.xlsx', b'XLSX')], 'ok'

    monkeypatch.setattr('flowa.download.fetch_pmc_paper', fake_fetch)
    await download_paper_async(base, DOI)

    assert read_bytes(paper_url(base, DOI, 'main.pdf')) == b'MAINPDF'
    # Shared ord sequence; the basename is sanitised (space -> underscore).
    assert read_bytes(paper_url(base, DOI, 'supplements/000_Fig_S1.pdf')) == b'PDFSUP'
    assert read_bytes(paper_url(base, DOI, 'supplements/001_table.xlsx')) == b'XLSX'


async def test_download_skips_when_main_pdf_exists(tmp_path, monkeypatch) -> None:
    base = str(tmp_path)
    write_bytes(paper_url(base, DOI, 'main.pdf'), b'EXISTING')
    write_json(paper_url(base, DOI, 'metadata.json'), {'pmid': 42})
    called = False

    async def fake_fetch(*args, **kwargs):
        nonlocal called
        called = True
        return b'NEW', [], 'ok'

    monkeypatch.setattr('flowa.download.fetch_pmc_paper', fake_fetch)
    await download_paper_async(base, DOI)

    assert not called  # main.pdf present -> the whole PMC fetch is skipped
    assert read_bytes(paper_url(base, DOI, 'main.pdf')) == b'EXISTING'
