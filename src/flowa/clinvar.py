"""Query ClinVar for variant classifications and format for LLM prompt."""

import logging
from typing import Any

import httpx
from defusedxml import ElementTree
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

log = logging.getLogger(__name__)

ESEARCH_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi'
EFETCH_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi'

# Non-germline classification labels to exclude from the prompt.
_NON_GERMLINE_CLASSIFICATIONS = frozenset(
    {
        'drug response',
        'risk factor',
        'association',
        'protective',
        'affects',
        'other',
    }
)

_REVIEW_STATUS_STARS: dict[str, int] = {
    'practice guideline': 4,
    'reviewed by expert panel': 3,
    'criteria provided, multiple submitters, no conflicts': 2,
    'criteria provided, conflicting classifications': 1,
    'criteria provided, single submitter': 1,
    'no assertion for the individual variant': 0,
    'no assertion criteria provided': 0,
    'no classification provided': 0,
}


def _api_params(ncbi_api_key: str | None) -> dict[str, str]:
    """Return common params, adding api_key when available."""
    return {'api_key': ncbi_api_key} if ncbi_api_key else {}


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(),
    retry=retry_if_exception_type(httpx.HTTPStatusError),
    reraise=True,
)
def _extract_variant_change(hgvs_c: str) -> str:
    """Extract the variant change from HGVS c. notation.

    'NM_006767.4:c.1943-256C>T' -> '1943-256C>T'
    """
    # Split on ':c.' and take the change part
    if ':c.' in hgvs_c:
        return hgvs_c.split(':c.', 1)[1]
    raise ValueError(f'Cannot extract variant change from HGVS: {hgvs_c}')


def query_clinvar(hgvs_c: str, gene: str, ncbi_api_key: str | None = None) -> dict[str, Any]:
    """Query ClinVar by gene + variant change and return parsed submission data.

    Uses the search format ``GENE AND (change OR Not found)`` which reliably
    returns the correct VariationID, unlike bare HGVS searches that get
    tokenized incorrectly by NCBI's ESearch.

    Returns a dict with 'found': False if the variant is not in ClinVar,
    or a structured dict with aggregate classification and per-submission
    details when found.
    """
    variant_change = _extract_variant_change(hgvs_c)
    search_term = f'{gene} AND ({variant_change} OR Not found)'
    log.info('Querying ClinVar for %s (search: %s)', hgvs_c, search_term)

    with httpx.Client(timeout=30.0) as client:
        # Step 1: ESearch to find VariationID
        response = client.get(
            ESEARCH_URL,
            params={
                'db': 'clinvar',
                'term': search_term,
                'retmode': 'json',
                **_api_params(ncbi_api_key),
            },
        )
        response.raise_for_status()
        search_result = response.json()

        id_list = search_result.get('esearchresult', {}).get('idlist', [])
        if not id_list:
            log.info('No ClinVar results for %s', hgvs_c)
            return {'found': False}

        if len(id_list) > 1:
            log.warning(
                'ClinVar search for %s returned %d results (IDs: %s), expected 1; using first',
                hgvs_c,
                len(id_list),
                ', '.join(id_list),
            )

        variation_id = id_list[0]
        log.info('Found ClinVar VariationID %s for %s', variation_id, hgvs_c)

        # Step 2: EFetch VCV XML with full submission details
        response = client.get(
            EFETCH_URL,
            params={
                'db': 'clinvar',
                'id': variation_id,
                'rettype': 'vcv',
                'retmode': 'xml',
                'is_variationid': '',
                **_api_params(ncbi_api_key),
            },
        )
        response.raise_for_status()

    return _parse_vcv_xml(response.content)


def _parse_vcv_xml(xml_bytes: bytes) -> dict[str, Any]:
    """Parse ClinVar VCV XML into a structured dict."""
    root = ElementTree.fromstring(xml_bytes)

    archive = root.find('.//VariationArchive')
    if archive is None:
        return {'found': False}

    # Aggregate classification
    agg_class = None
    agg_review = None
    gc = archive.find('.//Classifications/GermlineClassification')
    if gc is not None:
        desc = gc.find('Description')
        agg_class = desc.text if desc is not None else None
        rev = gc.find('ReviewStatus')
        agg_review = rev.text if rev is not None else None

    # Parse individual SCV assertions
    submissions = []
    for assertion in archive.findall('.//ClinicalAssertion'):
        scv = _parse_scv(assertion)
        if scv:
            submissions.append(scv)

    return {
        'found': True,
        'variation_id': archive.get('VariationID'),
        'variation_name': archive.get('VariationName'),
        'accession': archive.get('Accession'),
        'n_submissions': archive.get('NumberOfSubmissions'),
        'n_submitters': archive.get('NumberOfSubmitters'),
        'aggregate_classification': agg_class,
        'aggregate_review_status': agg_review,
        'submissions': submissions,
    }


def _parse_scv(assertion) -> dict[str, Any] | None:
    """Parse a single ClinicalAssertion (SCV) element."""
    scv: dict[str, Any] = {}

    # Submitter name — prefer abbreviation, fall back to full name
    acc_elem = assertion.find('ClinVarAccession')
    if acc_elem is not None:
        scv['submitter'] = acc_elem.get('OrgAbbreviation') or acc_elem.get('SubmitterName', '')
        scv['scv'] = acc_elem.get('Accession', '')

    # Classification and metadata
    class_elem = assertion.find('.//Classification')
    if class_elem is None:
        return None

    gdesc = class_elem.find('GermlineClassification')
    if gdesc is not None and gdesc.text:
        scv['classification'] = gdesc.text
    else:
        desc = class_elem.find('Description')
        if desc is not None and desc.text:
            scv['classification'] = desc.text

    if 'classification' not in scv:
        return None

    # Review status
    rev = class_elem.find('ReviewStatus')
    if rev is not None:
        scv['review_status'] = rev.text

    # Date last evaluated
    if class_elem.get('DateLastEvaluated'):
        scv['date'] = class_elem.get('DateLastEvaluated')

    # Free-text reasoning (the most valuable field for expert panels)
    comment = class_elem.find('Comment')
    if comment is not None and comment.text and comment.text.strip():
        scv['comment'] = comment.text.strip()

    # PubMed citations (deduplicated, order preserved)
    pmids: list[str] = []
    seen: set[str] = set()
    for cit_id in assertion.findall('.//Citation/ID'):
        if cit_id.get('Source') == 'PubMed' and cit_id.text and cit_id.text not in seen:
            pmids.append(cit_id.text)
            seen.add(cit_id.text)
    if pmids:
        scv['pmids'] = pmids

    return scv


def format_clinvar_for_prompt(data: dict[str, Any], max_chars: int = 6000) -> str:
    """Format parsed ClinVar data into token-optimized text for the LLM prompt.

    Tiered strategy:
    1. Aggregate classification + ClinVar link (always)
    2. Expert panel submissions with full comment text
    3. Classification counts for other submissions
    4. Selected non-expert comments (3 if expert panel exists, 5 otherwise)
    5. Hard truncation at max_chars
    """
    if not data.get('found'):
        return 'No ClinVar data available for this variant.'

    lines: list[str] = []

    # Header — compact, information-dense
    stars = _REVIEW_STATUS_STARS.get(data.get('aggregate_review_status', ''), 0)
    lines.append(
        f'**{data["aggregate_classification"]}** ({stars} stars, '
        f'{data["n_submitters"]} submitters) — '
        f'[{data["accession"]}]'
        f'(https://www.ncbi.nlm.nih.gov/clinvar/variation/{data["variation_id"]}/)'
    )
    lines.append('')

    # Filter to germline classifications only
    germline = [
        s
        for s in data.get('submissions', [])
        if s.get('classification', '').lower() not in _NON_GERMLINE_CLASSIFICATIONS
    ]

    # Split into expert panel vs other
    expert_subs = []
    other_subs = []
    for scv in germline:
        rs = scv.get('review_status', '').lower()
        if 'expert panel' in rs or 'practice guideline' in rs:
            expert_subs.append(scv)
        else:
            other_subs.append(scv)

    # Expert panel submissions — full detail
    if expert_subs:
        lines.append('Expert panel submissions:')
        for scv in expert_subs:
            date = scv.get('date', '?')
            lines.append(f'- {scv.get("submitter", "?")}: {scv.get("classification", "?")} ({date})')
            if scv.get('comment'):
                comment = scv['comment']
                if len(comment) > 2000:
                    comment = comment[:2000] + '...[truncated]'
                lines.append(f'  "{comment}"')
            if scv.get('pmids'):
                lines.append(f'  PMIDs: {", ".join(scv["pmids"])}')
        lines.append('')

    # Other submissions — classification counts + date range
    if other_subs:
        buckets: dict[str, int] = {}
        criteria_buckets: dict[str, int] = {}
        dates: list[str] = []
        for scv in other_subs:
            cls = scv.get('classification', 'Unknown')
            buckets[cls] = buckets.get(cls, 0) + 1
            if 'criteria provided' in scv.get('review_status', ''):
                criteria_buckets[cls] = criteria_buckets.get(cls, 0) + 1
            if d := scv.get('date'):
                dates.append(d)

        lines.append(f'Other submissions ({len(other_subs)}):')
        for cls, count in sorted(buckets.items(), key=lambda x: -x[1]):
            crit = criteria_buckets.get(cls, 0)
            crit_note = f', {crit} with criteria' if crit else ''
            lines.append(f'- {cls}: {count}{crit_note}')
        if dates:
            lines.append(f'- Date range: {min(dates)} to {max(dates)}')
        lines.append('')

        # Selected non-expert comments — more when no expert panel
        max_comments = 3 if expert_subs else 5
        commented = [s for s in other_subs if s.get('comment') and len(s['comment']) > 50]
        if commented:
            commented.sort(key=lambda s: len(s.get('comment', '')), reverse=True)
            shown = commented[:max_comments]
            lines.append(f'Selected submission comments ({len(commented)} total with text):')
            for scv in shown:
                comment = scv['comment']
                if len(comment) > 400:
                    comment = comment[:400] + '...'
                lines.append(f'- {scv.get("submitter", "?")} ({scv.get("classification", "?")}): "{comment}"')
            if len(commented) > max_comments:
                lines.append(f'  [{len(commented) - max_comments} more submissions with comments omitted]')

    result = '\n'.join(lines)

    if len(result) > max_chars:
        result = result[: max_chars - 20] + '\n...[truncated]'

    return result
