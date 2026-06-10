"""Tests for the genesis content-integrity checks.

These mirror chat-service's edit-time validation; the aggregate output
validator is a thin wrapper that calls `validate_aggregate_category` and raises
ModelRetry, so exercising it covers the gate logic.
"""

from flowa.artifact import AggregateCitation, CategoryResult, Claim, RankedPaper
from flowa.content_validation import validate_aggregate_category


def _cat(
    *,
    notes: str = '',
    description: str = '',
    papers: tuple[str, ...] = (),
    claims: tuple[Claim, ...] = (),
) -> CategoryResult:
    return CategoryResult(
        category='acmg_classification',
        description=description,
        notes=notes,
        papers=[RankedPaper(paper_id=p, rank_rationale='because') for p in papers],
        claims=list(claims),
    )


def _claim(paper_id: str, *quotes: str) -> Claim:
    return Claim(paper_id=paper_id, text='a fact', citations=[AggregateCitation(quote=q) for q in quotes])


def _rules(errors: list[tuple[str, str]]) -> set[str]:
    return {rule for rule, _ in errors}


# --- aggregate category validation -----------------------------------------

_Q1 = 'The variant occurred in nine unrelated probands.'
_Q2 = 'Functional assays showed under two percent residual activity.'


def test_valid_category_passes() -> None:
    cat = _cat(
        notes=f'Common ([nine probands](#cite:Smith2024 "{_Q1}")) and severe ([assay](#cite:Doe2023 "{_Q2}")).',
        description='',
        papers=('Smith2024', 'Doe2023'),
        claims=(_claim('Smith2024', _Q1), _claim('Doe2023', _Q2)),
    )
    errors = validate_aggregate_category(
        cat,
        valid_paper_ids={'Smith2024', 'Doe2023'},
        extraction_quotes_by_paper={'Smith2024': {_Q1}, 'Doe2023': {_Q2}},
    )
    assert errors == []


def test_dangling_notes_citation_flagged() -> None:
    cat = _cat(
        notes=f'See [this](#cite:Smith2024 "{_Q1}").',
        papers=('Smith2024',),
        claims=(_claim('Smith2024', 'a different quote that is in the claims'),),
    )
    errors = validate_aggregate_category(
        cat,
        valid_paper_ids={'Smith2024'},
        extraction_quotes_by_paper={'Smith2024': {'a different quote that is in the claims'}},
    )
    assert 'cite_quote_mismatch' in _rules(errors)


def test_notes_citation_missing_quote_flagged() -> None:
    cat = _cat(
        notes='See [this](#cite:Smith2024).',
        papers=('Smith2024',),
        claims=(_claim('Smith2024', _Q1),),
    )
    errors = validate_aggregate_category(
        cat, valid_paper_ids={'Smith2024'}, extraction_quotes_by_paper={'Smith2024': {_Q1}}
    )
    assert 'cite_missing_quote' in _rules(errors)


def test_notes_citation_unknown_paper_flagged() -> None:
    cat = _cat(
        notes=f'See [this](#cite:Ghost2099 "{_Q1}").',
        papers=('Smith2024',),
        claims=(_claim('Smith2024', _Q1),),
    )
    errors = validate_aggregate_category(
        cat, valid_paper_ids={'Smith2024'}, extraction_quotes_by_paper={'Smith2024': {_Q1}}
    )
    assert 'cite_unknown_paper_id' in _rules(errors)


def test_description_field_is_scanned() -> None:
    cat = _cat(
        description=f'Pathogenic ([evidence](#cite:Smith2024 "{_Q1}")).',
        papers=('Smith2024',),
        claims=(_claim('Smith2024', 'unrelated claim quote'),),
    )
    errors = validate_aggregate_category(
        cat, valid_paper_ids={'Smith2024'}, extraction_quotes_by_paper={'Smith2024': {'unrelated claim quote'}}
    )
    assert any(rule == 'cite_quote_mismatch' and field.startswith('description') for rule, field in errors)


def test_duplicate_paper_id_flagged() -> None:
    cat = _cat(papers=('Smith2024', 'Smith2024'), claims=(_claim('Smith2024', _Q1),))
    errors = validate_aggregate_category(
        cat, valid_paper_ids={'Smith2024'}, extraction_quotes_by_paper={'Smith2024': {_Q1}}
    )
    assert 'paper_id_duplicate' in _rules(errors)


def test_unknown_paper_id_flagged() -> None:
    cat = _cat(papers=('Smith2024',), claims=())
    errors = validate_aggregate_category(cat, valid_paper_ids={'Doe2023'}, extraction_quotes_by_paper={})
    assert 'paper_id_unknown' in _rules(errors)


def test_claim_paper_missing_flagged() -> None:
    cat = _cat(papers=('Smith2024',), claims=(_claim('Doe2023', _Q2),))
    errors = validate_aggregate_category(
        cat,
        valid_paper_ids={'Smith2024', 'Doe2023'},
        extraction_quotes_by_paper={'Doe2023': {_Q2}},
    )
    assert 'claim_paper_missing' in _rules(errors)


def test_non_contiguous_claims_flagged() -> None:
    cat = _cat(
        papers=('Smith2024', 'Doe2023'),
        claims=(_claim('Smith2024', _Q1), _claim('Doe2023', _Q2), _claim('Smith2024', 'second smith quote')),
    )
    errors = validate_aggregate_category(
        cat,
        valid_paper_ids={'Smith2024', 'Doe2023'},
        extraction_quotes_by_paper={'Smith2024': {_Q1, 'second smith quote'}, 'Doe2023': {_Q2}},
    )
    assert 'claims_not_contiguous' in _rules(errors)


def test_claim_group_order_must_match_papers() -> None:
    cat = _cat(
        papers=('Smith2024', 'Doe2023'),
        claims=(_claim('Doe2023', _Q2), _claim('Smith2024', _Q1)),
    )
    errors = validate_aggregate_category(
        cat,
        valid_paper_ids={'Smith2024', 'Doe2023'},
        extraction_quotes_by_paper={'Smith2024': {_Q1}, 'Doe2023': {_Q2}},
    )
    assert 'claims_group_order' in _rules(errors)


def test_claim_quote_must_come_from_extraction() -> None:
    cat = _cat(papers=('Smith2024',), claims=(_claim('Smith2024', _Q1),))
    errors = validate_aggregate_category(
        cat,
        valid_paper_ids={'Smith2024'},
        extraction_quotes_by_paper={'Smith2024': {'a quote the extraction actually surfaced'}},
    )
    assert 'claim_quote_not_in_extraction' in _rules(errors)


def test_claim_quote_substring_of_extraction_passes() -> None:
    # The extraction surfaces a long passage; the aggregator legitimately trims
    # it to its load-bearing clause. That contiguous substring is still verbatim
    # source text (it resolves to a highlight downstream), so it is grounded.
    surfaced = (
        'Each parent was heterozygous for one allele, and an unaffected sister did not have a mutation at either site.'
    )
    trimmed = 'an unaffected sister did not have a mutation at either site'
    cat = _cat(
        notes=f'Non-carrier sib ([sib](#cite:Smith2024 "{trimmed}")).',
        papers=('Smith2024',),
        claims=(_claim('Smith2024', trimmed),),
    )
    errors = validate_aggregate_category(
        cat,
        valid_paper_ids={'Smith2024'},
        extraction_quotes_by_paper={'Smith2024': {surfaced}},
    )
    assert errors == []
