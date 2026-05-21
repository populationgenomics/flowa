"""Query literature sources and resolve to DOIs."""

import asyncio
import logging
from typing import Any, Literal
from xml.etree.ElementTree import Element

import httpx
import typer
from defusedxml import ElementTree
from pydantic import ValidationError

from flowa.http_retry import retry_transient_http
from flowa.normalize import normalize_variant
from flowa.schema import (
    METADATA_SCHEMA_VERSION,
    QueryResult,
    VariantSpec,
    parse_variant_spec_cli,
    with_schema_version,
)
from flowa.settings import Settings
from flowa.storage import assessment_url, paper_url, read_json, write_json

log = logging.getLogger(__name__)


MAX_ARTICLES = 50
"""Cap on articles fetched per source.  Both Mastermind and LitVar return
relevance-ranked results, so the top entries are the most useful."""

# Mastermind returns 5 articles per page.
_MASTERMIND_PAGE_SIZE = 5
_MASTERMIND_MAX_PAGES = MAX_ARTICLES // _MASTERMIND_PAGE_SIZE

# LitVar search returns 10 results per page.
_LITVAR_PAGE_SIZE = 10
_LITVAR_MAX_PAGES = MAX_ARTICLES // _LITVAR_PAGE_SIZE


async def query_mastermind(hgvs_g: str, api_token: str) -> list[int]:
    """Query Mastermind API for PMIDs (relevance-ranked, capped).

    Uses the genomic HGVS form (`NC_<chr>.<ver>:g.<pos><ref>><alt>`) as the
    `variant` parameter. Per Spike B, this is one of two formats Mastermind
    accepts and is preferred over the legacy `GENE:c.` form because it's
    genomically unambiguous (no transcript-version-isoform conflation) and
    improves splice-variant recall — Mastermind tokenises c.-form queries
    against the splice region, returning unrelated papers.
    """
    log.info('Querying Mastermind for %s', hgvs_g)

    base_url = 'https://mastermind.genomenon.com/api/v2/articles'
    pmids: list[int] = []
    page = 1

    async with httpx.AsyncClient(timeout=30.0) as client:
        while True:
            log.debug('Fetching page %d', page)

            response = await client.get(
                base_url,
                params={
                    'api_token': api_token,
                    'variant': hgvs_g,
                    'page': page,
                },
            )
            if response.status_code == 404:
                # Mastermind returns 404 for variants with no articles in its
                # DB. Treat it as an empty result rather than an error so
                # callers can still run the rest of the pipeline (ClinVar
                # only). LitVar handles the same case via its empty-matches
                # branch already.
                log.warning('Mastermind has no articles for %s', hgvs_g)
                break
            response.raise_for_status()

            data = response.json()

            for article in data.get('articles', []):
                if pmid := article.get('pmid'):
                    pmids.append(int(pmid))

            total_pages = data.get('pages', 0)
            if page >= total_pages:
                break

            if page >= _MASTERMIND_MAX_PAGES:
                total_articles = data.get('article_count', total_pages * _MASTERMIND_PAGE_SIZE)
                log.warning(
                    'Capping Mastermind results at %d/%d articles',
                    len(pmids),
                    total_articles,
                )
                break

            page += 1

    return sorted(pmids)


_LITVAR_AUTOCOMPLETE_URL = 'https://www.ncbi.nlm.nih.gov/research/litvar2-api/variant/autocomplete/'
_LITVAR_SEARCH_URL = 'https://www.ncbi.nlm.nih.gov/research/litvar2-api/search/'


async def _litvar_resolve_variant_id(client: httpx.AsyncClient, query: str, *, expected_gene: str | None) -> str | None:
    """Look up LitVar's internal variant id for an autocomplete query.

    Returns the `_id` of the first match (filtered by `expected_gene` when
    supplied), or None when no match resolves. The gene filter is only
    useful for the `gene + p.short` fallback path — rsID queries are
    already unambiguous.
    """
    response = await client.get(_LITVAR_AUTOCOMPLETE_URL, params={'query': query})
    response.raise_for_status()
    matches = response.json()
    if not matches:
        return None

    if expected_gene:
        gene_lower = expected_gene.lower()
        matches = [m for m in matches if any(g.lower() == gene_lower for g in m.get('gene', []))]
        if not matches:
            return None

    selected = matches[0]
    log.info(
        'LitVar matched %r → %s (rsid=%s, pmids=%d)',
        query,
        selected.get('name'),
        selected.get('rsid', 'N/A'),
        selected.get('pmids_count', 0),
    )
    return selected['_id']


async def _litvar_fetch_pmids(client: httpx.AsyncClient, variant_id: str) -> list[int]:
    """Fetch PMIDs for a LitVar variant id (relevance-ranked, capped)."""
    pmids: list[int] = []
    page = 1
    while True:
        log.debug('Fetching LitVar search page %d for %s', page, variant_id)
        response = await client.get(
            _LITVAR_SEARCH_URL,
            params={'variant': variant_id, 'sort': 'score desc', 'page': page},
        )
        response.raise_for_status()
        data = response.json()
        for result in data.get('results', []):
            if pmid := result.get('pmid'):
                pmids.append(int(pmid))
        total_pages = data.get('total_pages', 0)
        if page >= total_pages:
            break
        if page >= _LITVAR_MAX_PAGES:
            log.warning('Capping LitVar results at %d articles', len(pmids))
            break
        page += 1
    return pmids


def _bare_change(hgvs_form: str | None) -> str | None:
    """Strip transcript / protein prefix from an HGVS form for LitVar queries.

    LitVar's autocomplete matches `GENE Y4725C` / `GENE c.14174A>G` more
    reliably than the full HGVS form, so we hand it the bare change after
    the colon (and after `p.` for protein forms, stripping any wrapping
    parentheses).
    """
    if not hgvs_form or ':' not in hgvs_form:
        return None
    bare = hgvs_form.split(':', 1)[1].removeprefix('p.').strip('()')
    return bare or None


async def query_litvar(
    *,
    rsid: str | None,
    gene_symbol: str,
    protein_short: str | None,
    hgvs_c: str | None,
) -> list[int]:
    """Query LitVar2 for PMIDs using the best available variant identifier.

    LitVar's autocomplete is a literature-indexing layer: it knows variants
    in whatever form papers mentioned them in. Its disambiguation engine
    maps across notations, but *only for variants where the cross-notation
    mapping has been seen in literature* — so a single query form can
    silently return zero matches for a variant that LitVar actually has
    indexed under a different form.

    Strategy (sequential, early-stop on first non-empty match):

    1. **rsID** when VEP supplied one — most reliable across notations
       (Spike G: every variant with an rsID resolved via every form, all
       routed to the same LitVar `_id`).
    2. **`gene + p.short`** — catches missense/nonsense variants typically
       cited in 1-letter protein form (Spike C3: RYR2 Y4725C, no rsID,
       resolves only via this path).
    3. **`gene + c.`** — last resort. Spike G found a real variant
       (MYBPC3 c.2864_2865delCT, frameshift, 48 PMIDs in LitVar) where
       neither (1) nor (2) resolves — frameshift variants often lack a
       clean p.short form, and rsID coverage isn't always supplied by
       upstream normalisers even when LitVar has rsID-indexed the entry.

    Stops on the first non-empty result and logs which path matched, so
    we can collect empirical data on fallback frequency. Returns an empty
    list (not an error) when no path matches — distinct from an HTTP
    failure, which propagates, so callers can still run the rest of the
    pipeline (e.g. ClinVar) without false-failing.

    Why not `gene + p.long` too? Spike G confirmed it's fully redundant:
    every variant where LitVar matched the 3-letter form was already
    covered by the 1-letter form on the same internal `_id`.
    """
    p_short_bare = _bare_change(protein_short)
    c_bare = _bare_change(hgvs_c)
    attempts: list[tuple[str, str, str | None]] = [
        # (path_label, autocomplete_query, expected_gene_for_filter)
        ('rsid', rsid or '', None),
        ('gene+p.short', f'{gene_symbol} {p_short_bare}' if p_short_bare else '', gene_symbol),
        ('gene+c.', f'{gene_symbol} {c_bare}' if c_bare else '', gene_symbol),
    ]

    async with httpx.AsyncClient(timeout=30.0) as client:
        for path_label, query, expected_gene in attempts:
            if not query:
                continue
            log.info('LitVar: trying %s path (%r)', path_label, query)
            litvar_id = await _litvar_resolve_variant_id(client, query, expected_gene=expected_gene)
            if litvar_id is None:
                continue
            pmids = await _litvar_fetch_pmids(client, litvar_id)
            if not pmids:
                log.info('LitVar: %s resolved but returned no PMIDs', path_label)
                continue
            log.info('LitVar: %s path matched (%d PMIDs)', path_label, len(pmids))
            return sorted(pmids)

    log.warning(
        'LitVar: no matches via rsID, gene+p.short, or gene+c. (rsid=%s, gene=%s, p.short=%s, c.=%s)',
        rsid,
        gene_symbol,
        protein_short,
        hgvs_c,
    )
    return []


EFETCH_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi'


def _extract_element_text(elem: Element | None) -> str:
    """Extract all text from an XML element, flattening any inline markup."""
    if elem is None:
        return ''
    return ''.join(elem.itertext()).strip()


def _parse_article_metadata(article_elem: Element) -> dict[str, Any]:
    """Parse metadata from a PubmedArticle XML element."""
    # Extract article IDs (DOI, PMID) from ArticleIdList
    article_ids: dict[str, str] = {}
    for article_id in article_elem.findall('.//PubmedData/ArticleIdList/ArticleId'):
        id_type = article_id.get('IdType')
        if id_type and article_id.text:
            article_ids[id_type] = article_id.text.strip()

    doi = article_ids.get('doi')
    pmid_str = article_ids.get('pubmed')
    pmid = int(pmid_str) if pmid_str else None

    # Title (may contain inline elements like <i>, <sup>)
    title = _extract_element_text(article_elem.find('.//MedlineCitation/Article/ArticleTitle'))

    # Authors — skip entries without LastName (consortiums, per commit ced10cc)
    author_parts: list[str] = []
    for author in article_elem.findall('.//MedlineCitation/Article/AuthorList/Author'):
        last_name_elem = author.find('LastName')
        if last_name_elem is None or not last_name_elem.text:
            continue
        fore_name_elem = author.find('ForeName')
        if fore_name_elem is not None and fore_name_elem.text:
            author_parts.append(f'{last_name_elem.text}, {fore_name_elem.text}')
        else:
            author_parts.append(last_name_elem.text)
    authors = '; '.join(author_parts)

    # Journal
    journal_elem = article_elem.find('.//MedlineCitation/Article/Journal/Title')
    journal = journal_elem.text.strip() if journal_elem is not None and journal_elem.text else None

    # Abstract — join all AbstractText elements
    abstract_elems = article_elem.findall('.//MedlineCitation/Article/Abstract/AbstractText')
    abstract_parts = [_extract_element_text(elem) for elem in abstract_elems]
    abstract = ' '.join(p for p in abstract_parts if p) or None

    # Entrez date
    entrez_date_elem = article_elem.find('.//PubmedData/History/PubMedPubDate[@PubStatus="entrez"]')
    entrez_date = _extract_date(entrez_date_elem)

    return {
        'doi': doi,
        'pmid': pmid,
        'title': title,
        'authors': authors,
        'date': entrez_date,
        'journal': journal,
        'abstract': abstract,
    }


def _extract_date(date_elem: Element | None) -> str | None:
    """Extract YYYY-MM-DD date from a PubMedPubDate element."""
    if date_elem is None:
        return None
    year_elem = date_elem.find('Year')
    month_elem = date_elem.find('Month')
    day_elem = date_elem.find('Day')
    if (
        year_elem is None
        or month_elem is None
        or day_elem is None
        or year_elem.text is None
        or month_elem.text is None
        or day_elem.text is None
    ):
        return None
    try:
        return f'{int(year_elem.text):04d}-{int(month_elem.text):02d}-{int(day_elem.text):02d}'
    except ValueError:
        return None


@retry_transient_http
async def fetch_pubmed_metadata_batch(pmids: list[int]) -> dict[int, dict[str, Any]]:
    """Fetch metadata for multiple papers from PubMed in a single EFetch request."""
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(
            EFETCH_URL,
            params={
                'db': 'pubmed',
                'id': ','.join(str(p) for p in pmids),
                'retmode': 'xml',
            },
        )
        response.raise_for_status()

    root = ElementTree.fromstring(response.content)
    results: dict[int, dict[str, Any]] = {}
    for article_elem in root.findall('PubmedArticle'):
        metadata = _parse_article_metadata(article_elem)
        pmid = metadata.get('pmid')
        if pmid is not None:
            results[pmid] = metadata

    return results


async def resolve_pmids_to_dois(base: str, pmids: list[int]) -> list[str]:
    """Resolve PMIDs to DOIs via PubMed metadata, storing metadata for each paper.

    Papers without a DOI are skipped.
    """
    if not pmids:
        return []

    metadata_by_pmid = await fetch_pubmed_metadata_batch(pmids)
    dois: list[str] = []

    for pmid in pmids:
        metadata = metadata_by_pmid.get(pmid)

        if metadata is None:
            log.warning('Skipping PMID %s: not found in EFetch response', pmid)
            continue

        doi = metadata.get('doi')
        if not doi:
            log.warning('Skipping PMID %s: no DOI available', pmid)
            continue

        write_json(paper_url(base, doi, 'metadata.json'), with_schema_version(metadata, METADATA_SCHEMA_VERSION))
        log.info('PMID %s -> DOI %s', pmid, doi)
        dois.append(doi)

    return dois


def _load_cached_query(cache_url: str) -> QueryResult | None:
    """Read and validate a cached QueryResult, or return None if missing/stale.

    A schema_version mismatch (e.g. an older cache predating the
    variant_spec refactor) shows up as ValidationError; we treat that as a
    cache miss and re-run.
    """
    try:
        raw = read_json(cache_url)
    except FileNotFoundError:
        return None
    try:
        return QueryResult.model_validate(raw)
    except ValidationError as exc:
        log.warning('Cached query.json is stale (%s); re-running', exc.errors()[0]['msg'])
        return None


async def query_pmids(
    variant_spec: VariantSpec,
    source: Literal['mastermind', 'litvar'],
    mastermind_api_token: str | None = None,
) -> list[int]:
    """Normalise the variant and query the chosen literature source for PMIDs.

    Stateless: no caching, no persistence. The full assessment pipeline uses
    `query_dois_async` (which also writes `variant_details.json` and resolves
    PMIDs to DOIs); callers that just need PMIDs for a given `variant_spec`
    (e.g. variant-sync's bundle-import flow) should use this function.
    """
    item = variant_spec.variants[0]
    hgvs = f'{item.transcript}:{item.hgvs_c}'
    log.info('Variant: %s (source: %s)', hgvs, source)
    variant_details = await normalize_variant(hgvs, item.transcript)
    return await _query_pmids_from_details(variant_details, source, mastermind_api_token)


async def _query_pmids_from_details(
    variant_details: dict,
    source: Literal['mastermind', 'litvar'],
    mastermind_api_token: str | None,
) -> list[int]:
    """Dispatch a literature query against a precomputed normalised-variant dict.

    Shared between `query_pmids` (variant-sync's entry point) and
    `query_dois_async` (the assessment pipeline, which still needs the
    normalised dict for `variant_details.json` persistence and so reuses
    this helper to avoid duplicating the field-picking logic).
    """
    if source == 'mastermind':
        if not mastermind_api_token:
            raise ValueError('MASTERMIND_API_TOKEN environment variable not set')
        return await query_mastermind(variant_details['grch38']['hgvs_g'], mastermind_api_token)

    # LitVar fallback args: prefer MANE Select's projection, fall back to
    # the caller's transcript when MANE has none (e.g. intronic / splice
    # variants lack a protein form).
    mane = variant_details.get('mane_select')
    user_tx = variant_details.get('user_transcript')
    protein_short = (mane and mane.get('protein_short')) or (user_tx and user_tx.get('protein_short')) or None
    litvar_hgvs_c = (mane and mane.get('hgvs_c')) or (user_tx and user_tx.get('hgvs_c')) or None
    return await query_litvar(
        rsid=variant_details.get('rsid'),
        gene_symbol=variant_details['gene_symbol'],
        protein_short=protein_short,
        hgvs_c=litvar_hgvs_c,
    )


async def query_dois_async(
    base: str,
    variant_id: str,
    variant_spec: VariantSpec,
    source: Literal['mastermind', 'litvar'],
    mastermind_api_token: str | None = None,
) -> list[str]:
    """Query literature sources and resolve PMIDs to DOIs."""
    cache_url = assessment_url(base, variant_id, 'query.json')
    variant_details_url = assessment_url(base, variant_id, 'variant_details.json')

    # Check cache first
    cached = _load_cached_query(cache_url)
    if cached is not None:
        log.info('Using cached query results (%d DOIs)', len(cached.dois))
        return cached.dois

    item = variant_spec.variants[0]
    hgvs = f'{item.transcript}:{item.hgvs_c}'
    log.info('Variant: %s (source: %s)', hgvs, source)

    # Normalise via VEP REST and store for downstream stages (extract, aggregate).
    variant_details = await normalize_variant(hgvs, item.transcript)
    write_json(variant_details_url, variant_details)
    log.info('Stored normalised variant to %s', variant_details_url)

    pmids = await _query_pmids_from_details(variant_details, source, mastermind_api_token)

    # Resolve PMIDs to DOIs and store metadata for each paper
    log.info('Resolving %d PMIDs to DOIs', len(pmids))
    dois = await resolve_pmids_to_dois(base, pmids)

    result = QueryResult(variant_spec=variant_spec, dois=dois)
    write_json(cache_url, result.model_dump())
    log.info('Cached query results to %s', cache_url)

    log.info('Found %d DOIs from %d PMIDs', len(dois), len(pmids))
    return dois


def query_dois(
    variant_id: str = typer.Option(..., '--variant-id', help='Unique identifier for this variant'),
    variant_spec_raw: str = typer.Option(
        ...,
        '--variant-spec',
        help='Variant spec as inline JSON or @path/to/spec.json',
    ),
    source: Literal['mastermind', 'litvar'] = typer.Option(..., '--source', '-s', help='Literature source to query'),
) -> None:
    """Query literature sources for variant DOIs.

    Queries Mastermind or LitVar for PMIDs, resolves each to a DOI via PubMed,
    and stores paper metadata. Caches results to object storage.
    """
    variant_spec = parse_variant_spec_cli(variant_spec_raw)
    s = Settings()  # type: ignore[call-arg]
    try:
        asyncio.run(query_dois_async(s.flowa_storage_base, variant_id, variant_spec, source, s.mastermind_api_token))
    except ValueError as e:
        log.error('%s', e)
        raise typer.Exit(1) from None
    except httpx.HTTPError as e:
        log.error('HTTP Error: %s', e)
        raise typer.Exit(1) from e
