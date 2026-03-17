"""Aggregate evidence across all papers for a variant."""

import asyncio
import json
import logging
import re
from typing import Any

import typer
from anchorite import resolve
from pydantic import BaseModel
from pydantic_ai import Agent, ModelRetry, RunContext

from flowa.clinvar import format_clinvar_for_prompt, query_clinvar
from flowa.models import create_model, get_thinking_settings
from flowa.prompts import load_prompt
from flowa.schema import AGGREGATE_SCHEMA_VERSION, with_schema_version
from flowa.settings import Settings
from flowa.storage import assessment_url, encode_doi, exists, paper_url, read_json, read_text, write_bytes, write_json

log = logging.getLogger(__name__)


# Paper ID generation ({LastName}{Year} format), ported from palit.


def _extract_first_author_last_name(authors: str) -> str:
    """Extract first author's last name from authors string.

    Authors are semicolon-separated in "Last, First" format:
    "Smith, John A; Doe, Jane B; ..." -> "Smith"
    "van der Berg, Anna; Doe, Jane; ..." -> "VanDerBerg"
    """
    if not authors:
        return 'Unknown'
    first_author = authors.split(';')[0].strip()
    # Take everything before the comma (the last name portion)
    last_name = first_author.split(',')[0].strip()
    if not last_name:
        return 'Unknown'
    parts = last_name.split()
    # Join multi-word last names, capitalize each part, remove non-alpha
    return ''.join(re.sub(r'[^A-Za-z]', '', p).capitalize() for p in parts)


def generate_paper_ids(
    evidence_list: list[dict[str, Any]],
) -> tuple[dict[str, str], dict[str, str]]:
    """Generate {LastName}{Year} paper IDs from evidence list.

    Each item must have 'doi', 'authors', and 'date' keys.

    Returns:
        Tuple of (paper_id_to_doi, doi_to_paper_id) mappings.
        Collisions are disambiguated with letter suffixes (a, b, c).
    """
    base_id_to_dois: dict[str, list[str]] = {}

    for evidence in evidence_list:
        doi = evidence['doi']
        authors = evidence.get('authors', '')
        date = evidence.get('date', '')
        last_name = _extract_first_author_last_name(authors)
        year = date[:4] if date and len(date) >= 4 else 'Unknown'
        base_id = f'{last_name}{year}'
        base_id_to_dois.setdefault(base_id, []).append(doi)

    paper_id_to_doi: dict[str, str] = {}
    doi_to_paper_id: dict[str, str] = {}
    for base_id, dois in base_id_to_dois.items():
        if len(dois) == 1:
            paper_id_to_doi[base_id] = dois[0]
            doi_to_paper_id[dois[0]] = base_id
        else:
            for i, doi in enumerate(sorted(dois)):
                suffixed_id = f'{base_id}{chr(ord("a") + i)}'
                paper_id_to_doi[suffixed_id] = doi
                doi_to_paper_id[doi] = suffixed_id

    return paper_id_to_doi, doi_to_paper_id


def create_aggregate_agent(
    model: str,
    paper_id_to_doi: dict[str, str],
    annotated_mds: dict[str, str],
    output_type: type[BaseModel],
) -> Agent[None, BaseModel]:
    """Create a Pydantic AI agent with citation validation across all papers."""
    agent: Agent[None, BaseModel] = Agent(
        create_model(model),
        output_type=output_type,
        retries=3,
        instructions='Always return your response by calling the final_result tool.',
        model_settings=get_thinking_settings(model, 'aggregation'),
    )

    @agent.output_validator
    def validate_citations(ctx: RunContext[None], result: BaseModel) -> BaseModel:
        """Validate that all citation (paper_id, quote) pairs can be resolved.

        Requires: result.results[category].citations[].paper_id and .quote
        """
        invalid = []

        for cat_result in result.results.values():  # type: ignore[attr-defined]
            for citation in cat_result.citations:
                doi = paper_id_to_doi.get(citation.paper_id)
                if doi is None or doi not in annotated_mds:
                    invalid.append(f'paper_id={citation.paper_id} (paper not found)')
                    continue
                resolved = resolve(annotated_mds[doi], [citation.quote])
                if not resolved.get(citation.quote):
                    invalid.append(f'paper_id={citation.paper_id}, quote not resolved: {citation.quote[:80]}...')

        if invalid:
            raise ModelRetry(f'Invalid citations: {"; ".join(invalid)}')

        return result

    return agent


def resolve_aggregate_citations(
    aggregate_dict: dict[str, Any],
    paper_id_to_doi: dict[str, str],
    annotated_mds: dict[str, str],
    metadata_cache: dict[str, dict[str, Any]],
) -> None:
    """Post-process aggregate output: resolve quotes to bboxes, enrich with DOI."""
    for cat_result in aggregate_dict['results'].values():
        for citation in cat_result['citations']:
            doi = paper_id_to_doi[citation.pop('paper_id')]
            citation['doi'] = doi
            quote = citation['quote']
            resolved = resolve(annotated_mds[doi], [quote])
            bboxes = []
            for page, bbox in resolved.get(quote, []):
                bboxes.append(
                    {
                        'page': page,
                        'top': bbox.top,
                        'left': bbox.left,
                        'bottom': bbox.bottom,
                        'right': bbox.right,
                    }
                )
            citation['bboxes'] = bboxes

    # Add paper_id_mapping so the UI can cross-reference prose with papers
    aggregate_dict['paper_id_mapping'] = {
        'byAuthorYear': {
            pid: {'doi': doi, 'pmid': metadata_cache[doi].get('pmid')} for pid, doi in paper_id_to_doi.items()
        },
        'byDoi': {doi: pid for pid, doi in paper_id_to_doi.items()},
    }


async def aggregate_evidence_async(
    base: str,
    variant_id: str,
    model: str,
    ncbi_api_key: str | None = None,
    prompt_set: str = 'generic',
    dry_run: bool = False,
) -> None:
    """Aggregate evidence across all papers for a variant."""
    aggregate_url = assessment_url(base, variant_id, 'aggregate.json')
    aggregate_raw_url = assessment_url(base, variant_id, 'aggregate_raw.json')

    # Load variant details and query data (stored by query command)
    variant_details = json.dumps(read_json(assessment_url(base, variant_id, 'variant_details.json')))
    query_data = read_json(assessment_url(base, variant_id, 'query.json'))
    dois = query_data['dois']

    # Fetch ClinVar evidence
    clinvar_data = query_clinvar(query_data['hgvs_c'], ncbi_api_key)
    clinvar_text = format_clinvar_for_prompt(clinvar_data)

    # Load extractions, annotated markdowns, and metadata for each paper
    evidence_extractions: list[dict[str, Any]] = []
    annotated_mds: dict[str, str] = {}
    metadata_cache: dict[str, dict[str, Any]] = {}

    for doi in dois:
        extraction_url = assessment_url(base, variant_id, 'extractions', f'{encode_doi(doi)}.json')

        if not exists(extraction_url):
            log.info('Skipping %s: no extraction', doi)
            continue

        extraction_data = read_json(extraction_url)

        if not extraction_data.get('variant_discussed'):
            log.info('Skipping %s: variant not discussed', doi)
            continue

        annotated_mds[doi] = read_text(paper_url(base, doi, 'annotated.md'))
        metadata = read_json(paper_url(base, doi, 'metadata.json'))
        metadata_cache[doi] = metadata

        entry: dict[str, Any] = {
            'doi': doi,
            'title': metadata['title'],
            'authors': metadata['authors'],
            'date': metadata['date'],
            'evidence': extraction_data['evidence'],
        }
        if metadata.get('pmid'):
            entry['pmid'] = metadata['pmid']
        evidence_extractions.append(entry)

    if not evidence_extractions and not clinvar_data.get('found'):
        log.warning('No papers or ClinVar data for this variant - writing empty aggregate')
        write_json(aggregate_url, with_schema_version({'results': {}}, AGGREGATE_SCHEMA_VERSION))
        return

    # Generate paper_ids and replace DOIs with human-readable IDs for the LLM
    paper_id_to_doi: dict[str, str] = {}
    if evidence_extractions:
        paper_id_to_doi, doi_to_paper_id = generate_paper_ids(evidence_extractions)
        for entry in evidence_extractions:
            entry['paper_id'] = doi_to_paper_id[entry.pop('doi')]
        evidence_extractions.sort(key=lambda x: x['date'], reverse=True)

    log.info(
        'Aggregating evidence from %d papers + ClinVar (model: %s)',
        len(evidence_extractions),
        model,
    )

    # Load prompt and schema from prompt set
    prompt_template, output_type = load_prompt('aggregate', prompt_set)

    evidence_text = (
        json.dumps(evidence_extractions, indent=2)
        if evidence_extractions
        else 'No papers discussing this variant were found.'
    )
    prompt = prompt_template.format(
        variant_details=variant_details,
        clinvar_data=clinvar_text,
        evidence_extractions=evidence_text,
    )

    if dry_run:
        print('=== PROMPT ===')
        print(prompt)
        print('\n=== CLINVAR ===')
        print(clinvar_text)
        print('\n=== PAPER ID MAPPING ===')
        for pid, doi in paper_id_to_doi.items():
            print(f'  {pid} -> {doi}')
        return

    # Create agent with citation validation
    agent = create_aggregate_agent(model, paper_id_to_doi, annotated_mds, output_type)

    log.info('Calling LLM for aggregate assessment')
    result = await agent.run(prompt)

    # Post-LLM: resolve quotes to bboxes, replace paper_id with DOI
    aggregate_dict = result.output.model_dump()
    resolve_aggregate_citations(aggregate_dict, paper_id_to_doi, annotated_mds, metadata_cache)

    # Store structured aggregate result
    write_json(aggregate_url, with_schema_version(aggregate_dict, AGGREGATE_SCHEMA_VERSION))

    # Store raw LLM conversation for debugging
    write_bytes(aggregate_raw_url, result.all_messages_json())

    results_map = result.output.results  # type: ignore[attr-defined]
    total_citations = sum(len(cat_result.citations) for cat_result in results_map.values())
    log.info(
        'Aggregated variant %s: %d categories, %d citations',
        variant_id,
        len(results_map),
        total_citations,
    )


def aggregate_evidence(
    variant_id: str = typer.Option(..., '--variant-id', help='Variant identifier'),
    dry_run: bool = typer.Option(False, '--dry-run', help='Dump prompt and exit without calling LLM'),
) -> None:
    """Aggregate evidence across all papers for a variant.

    Reads extraction results from assessments/{variant_id}/extractions/,
    variant details from variant_details.json, and paper metadata from
    papers/{encoded_doi}/metadata.json. Calls LLM for aggregate assessment and
    stores result to assessments/{variant_id}/aggregate.json.
    """
    s = Settings()  # type: ignore[call-arg]
    asyncio.run(
        aggregate_evidence_async(
            s.flowa_storage_base, variant_id, s.flowa_extraction_model, s.ncbi_api_key, s.flowa_prompt_set, dry_run
        )
    )
