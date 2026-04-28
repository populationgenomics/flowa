"""Query ClinVar for variant classifications and format for LLM prompt."""

import logging
from collections.abc import Iterable
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

_CLASSIFICATION_SHORTHAND: dict[str, str] = {
    'Pathogenic': 'P',
    'Likely pathogenic': 'LP',
    'Uncertain significance': 'VUS',
    'Likely benign': 'LB',
    'Benign': 'B',
    'Conflicting classifications of pathogenicity': 'Conflicting',
}

# ObservedData @Type values that map to a zygosity description.
_ZYGOSITY_TYPES: dict[str, str] = {
    'SingleHeterozygote': 'heterozygous',
    'CompoundHeterozygote': 'compound heterozygous',
    'Homozygous': 'homozygous',
    'Hemizygous': 'hemizygous',
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
def query_clinvar(hgvs_c: str, ncbi_api_key: str | None = None) -> dict[str, Any]:
    """Query ClinVar by HGVS c. notation and return parsed submission data.

    Uses a quoted exact-phrase search (``"NM_...:c.change"``) which forces
    NCBI ESearch to match the full HGVS string rather than tokenizing it
    into separate fields that can match unrelated variants.

    Returns a dict with 'found': False if the variant is not in ClinVar,
    or a structured dict with aggregate classification and per-submission
    details when found.
    """
    search_term = f'"{hgvs_c}"'
    log.info('Querying ClinVar for %s', hgvs_c)

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

    submissions = [scv for sa in archive.findall('.//ClinicalAssertion') if (scv := _parse_scv(sa)) is not None]

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


def _text(elem: Any, path: str) -> str | None:
    """Return stripped text at path under ``elem``, or None if absent/empty."""
    if elem is None:
        return None
    found = elem.find(path)
    if found is None or not found.text:
        return None
    stripped = found.text.strip()
    return stripped or None


def _parse_observation(obs_elem: Any) -> dict[str, Any]:
    """Parse one <ObservedIn> block to a flat dict; empty fields are omitted."""
    out: dict[str, Any] = {}

    sample = obs_elem.find('Sample')
    if sample is not None:
        if origin := _text(sample, 'Origin'):
            out['origin'] = origin
        if affected := _text(sample, 'AffectedStatus'):
            out['affected'] = affected
        if sex := _text(sample, 'Sex'):
            out['sex'] = sex

        age_parts: list[str] = []
        for age in sample.findall('Age'):
            age_type = age.get('Type', '')
            unit = age.get('age_unit', '')
            val = (age.text or '').strip()
            if val:
                age_parts.append(f'{age_type}={val}{unit}' if age_type else f'{val}{unit}')
        if age_parts:
            out['age'] = ', '.join(age_parts)

    if method := _text(obs_elem, 'Method/MethodType'):
        out['method'] = method

    # ObservedData carries zygosity / allele count / non-trivial descriptions.
    for od in obs_elem.findall('ObservedData'):
        for attr in od.findall('Attribute'):
            attr_type = attr.get('Type', '')
            if attr_type in _ZYGOSITY_TYPES:
                out['zygosity'] = _ZYGOSITY_TYPES[attr_type]
                if (int_val := attr.get('integerValue')) is not None:
                    try:
                        out['n_alleles'] = int(int_val)
                    except ValueError:
                        pass
            elif attr_type == 'VariantAlleles':
                if (int_val := attr.get('integerValue')) is not None:
                    try:
                        out['n_alleles'] = int(int_val)
                    except ValueError:
                        pass
            elif attr_type == 'Description':
                text = (attr.text or '').strip()
                if text and text.lower() != 'not provided':
                    out['description'] = text

    obs_traits = [
        txt for name in obs_elem.findall('.//TraitSet/Trait/Name/ElementValue') if (txt := (name.text or '').strip())
    ]
    if obs_traits:
        out['obs_trait'] = obs_traits

    return out


def _parse_scv(assertion: Any) -> dict[str, Any] | None:
    """Parse a single ClinicalAssertion (SCV) element to the curated schema.

    Returns ``None`` if the assertion has no ``Classification`` element at all
    (malformed); otherwise returns a dict with only the fields actually
    present (keys are omitted rather than set to ``None``).
    """
    out: dict[str, Any] = {}

    # Submission identity
    acc = assertion.find('ClinVarAccession')
    if acc is not None:
        if v := acc.get('SubmitterName'):
            out['submitter'] = v
        if v := acc.get('OrganizationCategory'):
            out['category'] = v
        if v := acc.get('Accession'):
            out['scv'] = v
        if v := acc.get('DateCreated'):
            out['date_created'] = v
        if v := acc.get('DateUpdated'):
            out['date_updated'] = v

    # Classification
    cls = assertion.find('Classification')
    if cls is None:
        return None

    classification = _text(cls, 'GermlineClassification') or _text(cls, 'Description')
    if classification:
        out['classification'] = classification
    if review := _text(cls, 'ReviewStatus'):
        out['review_status'] = review
    if date_eval := cls.get('DateLastEvaluated'):
        out['date_evaluated'] = date_eval
    if comment := _text(cls, 'Comment'):
        out['comment'] = comment

    pmids: list[str] = []
    erepo_url: str | None = None
    for cit in cls.findall('Citation'):
        for cit_id in cit.findall('ID'):
            if cit_id.get('Source') == 'PubMed' and cit_id.text:
                pmid = cit_id.text.strip()
                if pmid and pmid not in pmids:
                    pmids.append(pmid)
        url_elem = cit.find('URL')
        if url_elem is not None and url_elem.text:
            url = url_elem.text.strip()
            if 'erepo.clinicalgenome' in url:
                erepo_url = url
    if pmids:
        out['pmids'] = pmids
    if erepo_url:
        out['erepo_url'] = erepo_url

    if 'classification' not in out:
        return None

    # Assertion method + mode of inheritance
    for attr_set in assertion.findall('AttributeSet'):
        attr = attr_set.find('Attribute')
        if attr is None or not attr.text:
            continue
        attr_type = attr.get('Type', '')
        val = attr.text.strip()
        if not val:
            continue
        if attr_type == 'AssertionMethod':
            out['method_name'] = val
        elif attr_type == 'ModeOfInheritance':
            out['inheritance'] = val

    # Observations (list; a submission can have multiple)
    observations = [
        parsed for obs in assertion.findall('ObservedInList/ObservedIn') if (parsed := _parse_observation(obs))
    ]
    if observations:
        out['observations'] = observations

    # Submission-level conditions
    conditions = [
        txt for name in assertion.findall('TraitSet/Trait/Name/ElementValue') if (txt := (name.text or '').strip())
    ]
    if conditions:
        out['conditions'] = conditions

    return out


def _sort_submissions(subs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Sort submissions so the highest-signal entries come first.

    Priority: review-status tier desc → information density (comment + method)
    desc → date_evaluated desc. Uses stable-sort composition so we don't have
    to invert the string date key.
    """

    def info_density(s: dict[str, Any]) -> int:
        return (2 if s.get('method_name') else 0) + (1 if s.get('comment') else 0)

    def tier(s: dict[str, Any]) -> int:
        return _REVIEW_STATUS_STARS.get((s.get('review_status') or '').lower(), 0)

    # Apply in reverse priority order; each sort is stable.
    result = sorted(subs, key=lambda s: s.get('date_evaluated') or '', reverse=True)
    result = sorted(result, key=info_density, reverse=True)
    result = sorted(result, key=tier, reverse=True)
    return result


def _format_submission(s: dict[str, Any]) -> list[str]:
    """Render one submission as a list of Markdown lines."""
    lines: list[str] = []

    submitter = s.get('submitter') or '?'
    header_bits: list[str] = []
    if category := s.get('category'):
        header_bits.append(f'[{category}]')
    if scv := s.get('scv'):
        header_bits.append(f'({scv})')
    lines.append(f'- {submitter} ' + ' '.join(header_bits) if header_bits else f'- {submitter}')

    cls_raw = s.get('classification') or '?'
    cls = _CLASSIFICATION_SHORTHAND.get(cls_raw, cls_raw)
    review = s.get('review_status') or '?'
    date_eval = s.get('date_evaluated')
    date_created = s.get('date_created')
    date_updated = s.get('date_updated')

    date_bits: list[str] = []
    if date_eval:
        date_bits.append(f'evaluated {date_eval}')
    extras: list[str] = []
    if date_created:
        extras.append(f'created {date_created}')
    if date_updated and date_updated != date_created:
        extras.append(f'updated {date_updated}')

    date_str = ', '.join(date_bits)
    if extras:
        date_str = f'{date_str} ({", ".join(extras)})' if date_str else f'({", ".join(extras)})'

    second_line = f'  {cls} — {review}'
    if date_str:
        second_line += f' — {date_str}'
    lines.append(second_line)

    if method_name := s.get('method_name'):
        method_line = f'  Assertion method: {method_name}'
        if inheritance := s.get('inheritance'):
            method_line += f' ({inheritance})'
        lines.append(method_line)
    elif inheritance := s.get('inheritance'):
        lines.append(f'  Inheritance: {inheritance}')

    collection_methods = sorted({m for obs in s.get('observations') or [] if (m := obs.get('method'))})
    if collection_methods:
        lines.append(f'  Collection method: {", ".join(collection_methods)}')

    if conditions := s.get('conditions'):
        lines.append(f'  Condition: {"; ".join(conditions)}')

    if comment := s.get('comment'):
        lines.append(f'  Comment: {comment}')

    citation_parts: list[str] = []
    if pmids := s.get('pmids'):
        citation_parts.append('PMID ' + ', '.join(pmids))
    if erepo := s.get('erepo_url'):
        citation_parts.append(f'ClinGen erepo: {erepo}')
    if citation_parts:
        lines.append(f'  Citations: {"; ".join(citation_parts)}')

    for obs in s.get('observations') or []:
        bits: list[str] = []
        if origin := obs.get('origin'):
            bits.append(origin)
        if affected := obs.get('affected'):
            bits.append(f'affected {affected}')
        if zygosity := obs.get('zygosity'):
            bits.append(zygosity)
        if (n := obs.get('n_alleles')) is not None:
            bits.append(f'n={n}')
        if age := obs.get('age'):
            bits.append(f'age {age}')
        if sex := obs.get('sex'):
            bits.append(sex)
        if description := obs.get('description'):
            bits.append(f'"{description}"')
        if obs_trait := obs.get('obs_trait'):
            bits.append(f'trait: {"; ".join(obs_trait)}')
        if bits:
            lines.append(f'  Observation: {", ".join(bits)}')

    return lines


def _aggregate_counts_block(subs: Iterable[dict[str, Any]]) -> list[str]:
    """At-a-glance classification distribution across all germline submissions."""
    buckets: dict[str, int] = {}
    criteria_buckets: dict[str, int] = {}
    dates: list[str] = []
    subs_list = list(subs)
    for scv in subs_list:
        # Normalise case so "Pathogenic" and "pathogenic" collapse into one bucket.
        cls = (scv.get('classification') or 'Unknown').capitalize()
        buckets[cls] = buckets.get(cls, 0) + 1
        if 'criteria provided' in (scv.get('review_status') or '').lower():
            criteria_buckets[cls] = criteria_buckets.get(cls, 0) + 1
        if d := scv.get('date_evaluated'):
            dates.append(d)

    if not buckets:
        return []

    n = len(subs_list)
    lines: list[str] = [f'Classification distribution ({n} germline submission{"s" if n != 1 else ""}):']
    for cls, count in sorted(buckets.items(), key=lambda x: -x[1]):
        crit = criteria_buckets.get(cls, 0)
        crit_note = f', {crit} with criteria' if crit else ''
        lines.append(f'- {cls}: {count}{crit_note}')
    if dates:
        lines.append(f'- Date range: {min(dates)} to {max(dates)}')
    lines.append('')
    return lines


def format_clinvar_for_prompt(data: dict[str, Any], max_chars: int = 20_000) -> str:
    """Format parsed ClinVar data into LLM-prompt text.

    Strategy:
    1. Aggregate classification + ClinVar link (always present when found)
    2. Per-classification-bucket counts for non-expert submissions (summary)
    3. Each submission rendered with the same formatter (expert-panel and
       non-expert alike), sorted by review-status tier, information density,
       and recency so the most authoritative entries come first and any
       overflow truncation drops the least informative tail.
    4. Tail-chop at max_chars as a last-resort safety ceiling.
    """
    if not data.get('found'):
        return 'No ClinVar data available for this variant.'

    lines: list[str] = []

    stars = _REVIEW_STATUS_STARS.get(data.get('aggregate_review_status', '') or '', 0)
    lines.append(
        f'**{data["aggregate_classification"]}** ({stars} stars, '
        f'{data["n_submitters"]} submitters) — '
        f'[{data["accession"]}]'
        f'(https://www.ncbi.nlm.nih.gov/clinvar/variation/{data["variation_id"]}/)'
    )
    lines.append('')

    germline = [
        s
        for s in data.get('submissions', [])
        if (s.get('classification') or '').lower() not in _NON_GERMLINE_CLASSIFICATIONS
    ]

    lines.extend(_aggregate_counts_block(germline))

    lines.append('Submissions:')
    for scv in _sort_submissions(germline):
        lines.extend(_format_submission(scv))

    result = '\n'.join(lines)

    if len(result) > max_chars:
        log.warning(
            'ClinVar block for %s exceeded max_chars (%d > %d); truncating',
            data.get('accession'),
            len(result),
            max_chars,
        )
        result = result[: max_chars - 20] + '\n...[truncated]'

    return result
