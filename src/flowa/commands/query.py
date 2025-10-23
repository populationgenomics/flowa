"""Query literature sources for variant PMIDs."""

from typing import Literal

import httpx
import typer
from pydantic_settings import BaseSettings, SettingsConfigDict
from rich.console import Console

from flowa.db import create_variant, update_pmids

console = Console()


class Settings(BaseSettings):
    """Settings loaded from environment variables or .env file."""

    mastermind_api_token: str | None = None

    model_config = SettingsConfigDict(env_file='.env', env_file_encoding='utf-8', extra='ignore')


def query_mastermind(gene: str, hgvs_c: str, api_token: str) -> list[int]:
    """Query Mastermind API for PMIDs.

    Args:
        gene: Gene symbol (e.g., "GAA")
        hgvs_c: HGVS c. notation, with or without transcript (e.g., "c.2238G>C")
        api_token: Mastermind API token

    Returns:
        List of PMIDs
    """
    # Strip transcript prefix if present
    hgvs_c_stripped = hgvs_c.split(':', 1)[-1]

    # Construct variant string
    variant = f'{gene}:{hgvs_c_stripped}'
    console.print(f'[cyan]Querying Mastermind for {variant}...[/cyan]')

    base_url = 'https://mastermind.genomenon.com/api/v2/articles'
    pmids = []
    page = 1

    with httpx.Client(timeout=30.0) as client:
        while True:
            console.print(f'  Fetching page {page}...')

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

            # Extract PMIDs from current page
            for article in data.get('articles', []):
                if pmid := article.get('pmid'):
                    pmids.append(int(pmid))

            # Check if we've reached the last page
            total_pages = data.get('pages', 0)
            if page >= total_pages:
                break

            page += 1

    return pmids


def query_litvar(gene: str, hgvs_c: str) -> list[int]:
    """Query LitVar API for PMIDs.

    Args:
        gene: Gene symbol (e.g., "GAA")
        hgvs_c: HGVS c. notation, with or without transcript (e.g., "c.2238G>C")

    Returns:
        List of PMIDs
    """
    # Strip transcript prefix if present
    hgvs_c_stripped = hgvs_c.split(':', 1)[-1]

    # Construct query: "{gene} {hgvs_c}"
    query = f'{gene} {hgvs_c_stripped}'
    console.print(f'[cyan]Querying LitVar for {query}...[/cyan]')

    autocomplete_url = 'https://www.ncbi.nlm.nih.gov/research/litvar2-api/variant/autocomplete/'
    publications_base = 'https://www.ncbi.nlm.nih.gov/research/litvar2-api/variant/get'

    with httpx.Client(timeout=30.0) as client:
        # Step 1: Autocomplete to get variant matches
        console.print('  Step 1: Finding variant matches...')
        response = client.get(autocomplete_url, params={'query': query})
        response.raise_for_status()

        matches = response.json()

        if not matches:
            console.print('[yellow]  No matches found in LitVar[/yellow]')
            return []

        # Step 2: Filter matches by gene and prefer MANE Select
        gene_lower = gene.lower()
        matching_variants = []

        for match in matches:
            match_genes = match.get('gene', [])
            # Case-insensitive gene match
            if any(g.lower() == gene_lower for g in match_genes):
                matching_variants.append(match)

        if not matching_variants:
            console.print(f'[yellow]  No matches for gene {gene}[/yellow]')
            return []

        # Prefer MANE Select transcript (would need additional metadata)
        # For now, just take the first match
        selected = matching_variants[0]
        rsid = selected['rsid']
        variant_id = selected['_id']

        console.print(f'  Found variant: {selected["name"]} (rsid: {rsid})')
        console.print(f'  PMID count: {selected.get("pmids_count", 0)}')

        # Step 3: Get publications
        console.print('  Step 2: Fetching publications...')

        # URL-encode the variant ID (e.g., "litvar@rs1800312##")
        # Replace @ with %40 and # with %23
        variant_id_encoded = variant_id.replace('@', '%40').replace('#', '%23')
        publications_url = f'{publications_base}/{variant_id_encoded}/publications'

        response = client.get(publications_url)
        response.raise_for_status()

        data = response.json()
        pmids = data.get('pmids', [])

        return pmids


def query_pmids(
    gene: str = typer.Option(..., '--gene', '-g', help='Gene symbol (e.g., GAA)'),
    hgvs: str = typer.Option(..., '--hgvs', '-v', help='HGVS c. notation (e.g., c.2238G>C)'),
    variant_id: str = typer.Option(..., '--id', help='Unique identifier for this variant'),
    source: Literal['mastermind', 'litvar'] = typer.Option(..., '--source', '-s', help='Literature source to query'),
) -> None:
    """Query literature sources for variant PMIDs.

    Creates or updates a variant in the database and stores the retrieved PMIDs.

    Examples:
        flowa query --gene GAA --hgvs "c.2238G>C" --id GAA_variant --source litvar
        flowa query -g BRAF -v "c.1799T>A" --id BRAF_V600E --source mastermind
    """
    settings = Settings()

    # Create/update variant in database
    console.print(f'\n[bold]Variant:[/bold] {gene} {hgvs}')
    console.print(f'[bold]ID:[/bold] {variant_id}')
    console.print(f'[bold]Source:[/bold] {source}\n')

    create_variant(variant_id=variant_id, gene=gene, hgvs_c=hgvs)

    # Query the selected source
    try:
        if source == 'mastermind':
            if not settings.mastermind_api_token:
                console.print('[red]Error: MASTERMIND_API_TOKEN environment variable not set[/red]')
                raise typer.Exit(1)

            pmids = query_mastermind(gene, hgvs, settings.mastermind_api_token)

        elif source == 'litvar':
            pmids = query_litvar(gene, hgvs)

        else:
            console.print(f'[red]Error: Unknown source: {source}[/red]')
            raise typer.Exit(1)

    except httpx.HTTPError as e:
        console.print(f'[red]HTTP Error: {e}[/red]')
        raise typer.Exit(1) from e

    # Update database with PMIDs
    pmids.sort()
    update_pmids(variant_id=variant_id, pmids=pmids)

    # Print results
    console.print(f'\n[green]✓ Found {len(pmids)} articles[/green]')

    if pmids:
        console.print('\n[bold]PMIDs:[/bold]')
        for pmid in pmids[:50]:  # Show first 50
            console.print(f'  - https://pubmed.ncbi.nlm.nih.gov/{pmid}')

        if len(pmids) > 50:
            console.print(f'  ... and {len(pmids) - 50} more')

    console.print(f'\n[dim]Stored in database with ID: {variant_id}[/dim]')
