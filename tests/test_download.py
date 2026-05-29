"""Unit tests for the pure helpers in `flowa.download`.

The network/S3 path (`fetch_pmc_paper`, `download_paper_async`) is exercised
end-to-end by the demo runbook; these cover the deterministic partitioning and
filename-sanitisation logic that decides which supplements are ingested and
where they land.
"""

from flowa.download import _partition_media_urls, _sanitize_supplement_filename


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
