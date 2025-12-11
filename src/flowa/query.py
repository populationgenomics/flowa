"""Query literature sources for variant PMIDs."""

import json
import logging
from dataclasses import asdict, dataclass
from typing import Literal

import httpx
import typer
from pydantic_settings import BaseSettings, SettingsConfigDict

from flowa.storage import assessment_url, read_json, write_json


@dataclass
class QueryResult:
    """Standardized query result for downstream tasks."""

    gene: str
    hgvs_c: str
    pmids: list[int]


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


def query_mastermind(gene: str, hgvs_c: str, api_token: str) -> QueryResult:
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

    return QueryResult(gene=gene, hgvs_c=hgvs_c, pmids=sorted(pmids))


def query_litvar(gene: str, hgvs_c: str) -> QueryResult:
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
            return QueryResult(gene=gene, hgvs_c=hgvs_c, pmids=[])

        # Filter matches by gene
        gene_lower = gene.lower()
        matching_variants = [match for match in matches if any(g.lower() == gene_lower for g in match.get('gene', []))]

        if not matching_variants:
            log.warning('No matches for gene %s', gene)
            return QueryResult(gene=gene, hgvs_c=hgvs_c, pmids=[])

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
        pmids = data.get('pmids', [])

    return QueryResult(gene=gene, hgvs_c=hgvs_c, pmids=sorted(pmids))


def query_pmids(
    variant_id: str = typer.Option(..., '--variant-id', help='Unique identifier for this variant'),
    gene: str = typer.Option(..., '--gene', '-g', help='Gene symbol (e.g., GAA)'),
    hgvs_c: str = typer.Option(..., '--hgvs-c', '-v', help='HGVS c. notation (e.g., c.2238G>C)'),
    source: Literal['mastermind', 'litvar'] = typer.Option(..., '--source', '-s', help='Literature source to query'),
) -> None:
    """Query literature sources for variant PMIDs.

    Outputs PMID list as JSON array to stdout (for Airflow XCom capture).
    Caches results to object storage for subsequent runs.
    Also stores variant details from VariantValidator for downstream tasks.
    """
    settings = Settings()
    cache_url = assessment_url(variant_id, 'query.json')
    variant_details_url = assessment_url(variant_id, 'variant_details.json')

    # Check cache first
    try:
        cached = read_json(cache_url)
        log.info('Using cached query results (%d PMIDs)', len(cached['pmids']))
        print(json.dumps(cached['pmids']))
        return
    except FileNotFoundError:
        pass

    log.info('Variant: %s %s (source: %s)', gene, hgvs_c, source)

    # Query VariantValidator for variant details and store for downstream tasks
    variant_details = query_variant_validator(hgvs_c)
    write_json(variant_details_url, variant_details)
    log.info('Stored variant details to %s', variant_details_url)

    # Query literature source
    try:
        if source == 'mastermind':
            if not settings.mastermind_api_token:
                log.error('MASTERMIND_API_TOKEN environment variable not set')
                raise typer.Exit(1)
            result = query_mastermind(gene, hgvs_c, settings.mastermind_api_token)

        else:  # litvar
            result = query_litvar(gene, hgvs_c)

    except httpx.HTTPError as e:
        log.error('HTTP Error: %s', e)
        raise typer.Exit(1) from e

    # Cache result to object storage
    write_json(cache_url, asdict(result))
    log.info('Cached query results to %s', cache_url)

    # Output PMID list to stdout for Airflow XCom
    log.info('Found %d articles', len(result.pmids))
    print(json.dumps(result.pmids))
