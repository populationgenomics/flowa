"""Internal-consistency checks for aggregation output.

These run at *genesis* (the `aggregate` pipeline stage) so the artifact is born
valid, mirroring the edit-time checks `@flowajs/chat-service` already enforces
on every commit. Every rule compares the model's own output against itself —
id set-membership, claim grouping/order, and exact string equality between a
notes `#cite` quote and a claim citation quote. There is deliberately **no
source-document matching and no fuzzy threshold**: those checks (verbatim
grounding, contiguity) are heuristics with false positives/negatives, and a
non-grounding quote already degrades gracefully downstream (no bbox/anchor →
no highlight). Grounding enforcement, if ever wanted, belongs in the
anchorite-backed resolver, not here.

Keep in sync with `packages/chat-service/src/chat.ts` (`validateArtifactContent`).
One rule here has no edit-time counterpart — `claim_quote_not_in_extraction`:
every claim citation quote must be one the extraction surfaced. It's the same
kind of exact, model-vs-model check; chat-service can't run it because an edit
session has no extraction input to compare against.
"""

import re
from typing import Protocol

# Mirrors chat.ts CITE_LINK_RE: [link text](#cite:paper_id "verbatim quote").
# Group 1 = paper_id; group 2 = quote (absent when the title attribute is
# omitted, surfaced as `cite_missing_quote`).
_CITE_LINK_RE = re.compile(r'\[[^\]]*\]\(#cite:([^ )"]+)(?:\s+"([^"]*)")?\)')


class _RankedPaper(Protocol):
    paper_id: str


class _Citation(Protocol):
    quote: str


class _Claim(Protocol):
    paper_id: str
    citations: list[_Citation]


class _CategoryResult(Protocol):
    description: str
    notes: str
    papers: list[_RankedPaper]
    claims: list[_Claim]


def validate_aggregate_category(
    cat_result: _CategoryResult,
    valid_paper_ids: set[str],
    extraction_quotes_by_paper: dict[str, set[str]],
) -> list[tuple[str, str]]:
    """Validate one aggregate category result; return (rule, message) pairs.

    Empty result means valid. Mirrors chat-service `validateArtifactContent`
    (paper-id membership, claim grouping/order, citation fidelity) and adds the
    genesis-only `claim_quote_not_in_extraction` rule: every claim citation quote
    must come from that paper's extraction input — the aggregate stage never sees
    the paper Markdown, so this exact model-vs-model check catches the model
    fabricating or silently altering a quote that wasn't in the extraction.
    """
    errors: list[tuple[str, str]] = []

    paper_ids = [p.paper_id for p in cat_result.papers]
    paper_id_set = set(paper_ids)

    if len(paper_ids) != len(paper_id_set):
        duplicates = sorted({pid for pid in paper_ids if paper_ids.count(pid) > 1})
        errors.append(('paper_id_duplicate', f'papers[] has duplicate paper_id(s): {", ".join(duplicates)}'))

    for pid in paper_ids:
        if pid not in valid_paper_ids:
            errors.append(('paper_id_unknown', f'papers[] contains unknown paper_id="{pid}" not in paper_id_mapping'))

    for claim in cat_result.claims:
        if claim.paper_id not in paper_id_set:
            errors.append(('claim_paper_missing', f'claim cites paper_id="{claim.paper_id}" not present in papers[]'))

    # Claims must appear in contiguous runs per paper, and those runs must follow
    # papers[] order (papers without claims may be skipped).
    first_seen: dict[str, int] = {}
    last_seen: dict[str, int] = {}
    for i, claim in enumerate(cat_result.claims):
        first_seen.setdefault(claim.paper_id, i)
        last_seen[claim.paper_id] = i
    for pid, first in first_seen.items():
        for i in range(first, last_seen[pid] + 1):
            if cat_result.claims[i].paper_id != pid:
                errors.append(
                    (
                        'claims_not_contiguous',
                        f'claims[] must be grouped contiguously by paper_id — claim #{i + 1} breaks the "{pid}" group',
                    )
                )
                break
    paper_rank = {pid: i for i, pid in enumerate(paper_ids)}
    claim_group_order = list(first_seen.keys())
    for i in range(1, len(claim_group_order)):
        prev = paper_rank.get(claim_group_order[i - 1])
        cur = paper_rank.get(claim_group_order[i])
        if prev is not None and cur is not None and prev > cur:
            errors.append(
                (
                    'claims_group_order',
                    f'claims[] groups must match papers[] order — "{claim_group_order[i]}" (rank {cur}) appears after "{claim_group_order[i - 1]}" (rank {prev})',
                )
            )
            break

    # Every claim citation quote must be one the extraction surfaced.
    for claim in cat_result.claims:
        allowed = extraction_quotes_by_paper.get(claim.paper_id, set())
        for citation in claim.citations:
            if citation.quote not in allowed:
                errors.append(
                    (
                        'claim_quote_not_in_extraction',
                        f'claim for "{claim.paper_id}" cites a quote absent from that paper\'s extraction input (quote: {citation.quote!r})',
                    )
                )

    # Citation fidelity: every notes/description #cite quote must exactly match a
    # claim citation quote for the same paper.
    claim_quotes_by_paper: dict[str, set[str]] = {}
    for claim in cat_result.claims:
        bucket = claim_quotes_by_paper.setdefault(claim.paper_id, set())
        bucket.update(citation.quote for citation in claim.citations)

    for field_name, text in (('notes', cat_result.notes), ('description', cat_result.description)):
        for match in _CITE_LINK_RE.finditer(text or ''):
            pid, quote = match.group(1), match.group(2)
            if pid not in paper_id_set:
                errors.append(('cite_unknown_paper_id', f'{field_name}: #cite:{pid} references an unknown paper_id'))
                continue
            if quote is None:
                errors.append(
                    (
                        'cite_missing_quote',
                        f'{field_name}: citation link for paper {pid} is missing a "verbatim quote" title attribute',
                    )
                )
                continue
            if quote not in claim_quotes_by_paper.get(pid, set()):
                errors.append(
                    (
                        'cite_quote_mismatch',
                        f'{field_name}: quote referenced by #cite:{pid} does not match any claim citation for "{pid}" (quote: {quote!r})',
                    )
                )

    return errors
