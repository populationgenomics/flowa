"""Query literature sources and resolve to DOIs."""

import json
import logging
from dataclasses import asdict, dataclass
from typing import Any, Literal

import httpx
import typer
from metapub import PubMedFetcher  # type: ignore[import-untyped]
from metapub.ncbi_errors import NCBIServiceError  # type: ignore[import-untyped]
from pydantic_settings import BaseSettings, SettingsConfigDict
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from flowa.schema import METADATA_SCHEMA_VERSION, QUERY_SCHEMA_VERSION, with_schema_version
from flowa.storage import assessment_url, paper_url, read_json, write_json


@dataclass
class QueryResult:
    """Standardized query result for downstream tasks."""

    gene: str
    hgvs_c: str
    dois: list[str]


VARIANT_VALIDATOR_BASE_URL = 'https://rest.variantvalidator.org/VariantValidator/variantvalidator'

log = logging.getLogger(__name__)


class Settings(BaseSettings):
    """Settings loaded from environment variables."""

    mastermind_api_token: str | None = None

    model_config = SettingsConfigDict(env_file='.env', env_file_encoding='utf-8', extra='ignore')


def query_variant_validator(hgvs_c: str) -> dict:
    """Query VariantValidator API for variant details."""
    url = f'{VARIANT_VALIDATOR_BASE_URL}/GRCh38/{hgvs_c}/mane_select'

    log.info('Querying VariantValidator for %s', hgvs_c)

    with httpx.Client(timeout=30.0) as client:
        response = client.get(
            url,
            params={'content-type': 'application/json'},
            headers={'accept': 'application/json'},
        )
        response.raise_for_status()
        return response.json()


def query_mastermind(gene: str, hgvs_c: str, api_token: str) -> list[int]:
    """Query Mastermind API for PMIDs."""
    hgvs_c_stripped = hgvs_c.split(':', 1)[-1]
    variant = f'{gene}:{hgvs_c_stripped}'
    log.info('Querying Mastermind for %s', variant)

    base_url = 'https://mastermind.genomenon.com/api/v2/articles'
    pmids: list[int] = []
    page = 1

    with httpx.Client(timeout=30.0) as client:
        while True:
            log.debug('Fetching page %d', page)

            response = client.get(
                base_url,
                params={
                    'api_token': api_token,
                    'variant': variant,
                    'page': page,
                },
            )
            response.raise_for_status()

            data = response.json()

            for article in data.get('articles', []):
                if pmid := article.get('pmid'):
                    pmids.append(int(pmid))

            total_pages = data.get('pages', 0)
            if page >= total_pages:
                break

            page += 1

    return sorted(pmids)


def query_litvar(gene: str, hgvs_c: str) -> list[int]:
    """Query LitVar API for PMIDs."""
    hgvs_c_stripped = hgvs_c.split(':', 1)[-1]
    query = f'{gene} {hgvs_c_stripped}'
    log.info('Querying LitVar for %s', query)

    autocomplete_url = 'https://www.ncbi.nlm.nih.gov/research/litvar2-api/variant/autocomplete/'
    publications_base = 'https://www.ncbi.nlm.nih.gov/research/litvar2-api/variant/get'

    with httpx.Client(timeout=30.0) as client:
        log.debug('Finding variant matches')
        response = client.get(autocomplete_url, params={'query': query})
        response.raise_for_status()

        matches = response.json()

        if not matches:
            log.warning('No matches found in LitVar')
            return []

        # Filter matches by gene
        gene_lower = gene.lower()
        matching_variants = [match for match in matches if any(g.lower() == gene_lower for g in match.get('gene', []))]

        if not matching_variants:
            log.warning('No matches for gene %s', gene)
            return []

        # Take first match (could prefer MANE Select in future)
        selected = matching_variants[0]
        litvar_variant_id = selected['_id']

        log.info(
            'Found variant: %s (rsid: %s, pmids: %d)',
            selected['name'],
            selected.get('rsid', 'N/A'),
            selected.get('pmids_count', 0),
        )

        # Get publications
        log.debug('Fetching publications')
        litvar_variant_id_encoded = litvar_variant_id.replace('@', '%40').replace('#', '%23')
        publications_url = f'{publications_base}/{litvar_variant_id_encoded}/publications'

        response = client.get(publications_url)
        response.raise_for_status()

        data = response.json()
        return sorted(data.get('pmids', []))


@retry(
    stop=stop_after_attempt(5),
    wait=wait_exponential(),
    retry=retry_if_exception_type(NCBIServiceError),
    reraise=True,
)
def _fetch_pubmed_metadata(pmid: int, fetcher: PubMedFetcher) -> dict[str, Any]:
    """Fetch metadata for a paper from PubMed with retry on rate limit."""
    article = fetcher.article_by_pmid(pmid)
    authors = '; '.join(
        f'{au.last_name}, {au.fore_name}' if au.fore_name else au.last_name
        for au in article.author_list
    )
    return {
        'doi': article.doi,
        'pmid': pmid,
        'title': article.title,
        'authors': authors,
        'date': article.history['entrez'].date().isoformat(),
        'journal': article.journal,
        'abstract': article.abstract,
    }


def resolve_pmids_to_dois(pmids: list[int]) -> list[str]:
    """Resolve PMIDs to DOIs via PubMed metadata, storing metadata for each paper.

    Papers without a DOI are skipped.
    """
    fetcher = PubMedFetcher()
    dois: list[str] = []

    for pmid in pmids:
        metadata = _fetch_pubmed_metadata(pmid, fetcher)
        doi = metadata.get('doi')

        if not doi:
            log.warning('Skipping PMID %s: no DOI available', pmid)
            continue

        write_json(paper_url(doi, 'metadata.json'), with_schema_version(metadata, METADATA_SCHEMA_VERSION))
        log.info('PMID %s -> DOI %s', pmid, doi)
        dois.append(doi)

    return dois


def query_dois(
    variant_id: str = typer.Option(..., '--variant-id', help='Unique identifier for this variant'),
    gene: str = typer.Option(..., '--gene', '-g', help='Gene symbol (e.g., GAA)'),
    hgvs_c: str = typer.Option(..., '--hgvs-c', '-v', help='HGVS c. notation (e.g., c.2238G>C)'),
    source: Literal['mastermind', 'litvar'] = typer.Option(..., '--source', '-s', help='Literature source to query'),
) -> None:
    """Query literature sources for variant DOIs.

    Queries Mastermind or LitVar for PMIDs, resolves each to a DOI via PubMed,
    and stores paper metadata. Outputs DOI list as JSON array to stdout
    (for Airflow XCom capture). Caches results to object storage.
    """
    settings = Settings()
    cache_url = assessment_url(variant_id, 'query.json')
    variant_details_url = assessment_url(variant_id, 'variant_details.json')

    # Check cache first
    try:
        cached = read_json(cache_url)
        log.info('Using cached query results (%d DOIs)', len(cached['dois']))
        print(json.dumps(cached['dois']))
        return
    except FileNotFoundError:
        pass

    log.info('Variant: %s %s (source: %s)', gene, hgvs_c, source)

    # Query VariantValidator for variant details and store for downstream tasks
    variant_details = query_variant_validator(hgvs_c)
    write_json(variant_details_url, variant_details)
    log.info('Stored variant details to %s', variant_details_url)

    # Query literature source for PMIDs
    try:
        if source == 'mastermind':
            if not settings.mastermind_api_token:
                log.error('MASTERMIND_API_TOKEN environment variable not set')
                raise typer.Exit(1)
            pmids = query_mastermind(gene, hgvs_c, settings.mastermind_api_token)

        else:  # litvar
            pmids = query_litvar(gene, hgvs_c)

    except httpx.HTTPError as e:
        log.error('HTTP Error: %s', e)
        raise typer.Exit(1) from e

    # Resolve PMIDs to DOIs and store metadata for each paper
    log.info('Resolving %d PMIDs to DOIs', len(pmids))
    dois = resolve_pmids_to_dois(pmids)

    result = QueryResult(gene=gene, hgvs_c=hgvs_c, dois=dois)
    write_json(cache_url, with_schema_version(asdict(result), QUERY_SCHEMA_VERSION))
    log.info('Cached query results to %s', cache_url)

    log.info('Found %d DOIs from %d PMIDs', len(dois), len(pmids))
    print(json.dumps(dois))
