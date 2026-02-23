"""Aggregate evidence across all papers for a variant."""

import json
import logging
import os
import re
from typing import Any

import typer
from pydantic import BaseModel
from pydantic_ai import Agent, ModelRetry, RunContext

from flowa.docling import load_bbox_mapping
from flowa.models import create_model, get_thinking_settings
from flowa.prompts import load_prompt
from flowa.schema import AGGREGATE_SCHEMA_VERSION, with_schema_version
from flowa.storage import assessment_url, exists, paper_url, read_json, write_bytes, write_json

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
    bbox_mappings: dict[str, dict[int, Any]],
    output_type: type[BaseModel],
) -> Agent[None, BaseModel]:
    """Create a Pydantic AI agent with citation validation across all papers."""
    agent: Agent[None, BaseModel] = Agent(
        create_model(model),
        output_type=output_type,
        retries=3,
        model_settings=get_thinking_settings(model, 'aggregation'),
    )

    @agent.output_validator
    def validate_citations(ctx: RunContext[None], result: BaseModel) -> BaseModel:
        """Validate that all citation (paper_id, box_id) pairs exist.

        Requires: result.results[category].citations[].paper_id and .box_id
        """
        invalid = []

        for category, cat_result in result.results.items():  # type: ignore[attr-defined]
            for citation in cat_result.citations:
                doi = paper_id_to_doi.get(citation.paper_id)
                if doi is None or doi not in bbox_mappings:
                    invalid.append(f'paper_id={citation.paper_id} (paper not found)')
                elif citation.box_id not in bbox_mappings[doi]:
                    invalid.append(f'paper_id={citation.paper_id}, box_id={citation.box_id}, category={category}')

        if invalid:
            raise ModelRetry(f'Invalid citations not found in documents: {", ".join(invalid)}')

        return result

    return agent


def aggregate_evidence(
    variant_id: str = typer.Option(..., '--variant-id', help='Variant identifier'),
    dry_run: bool = typer.Option(False, '--dry-run', help='Dump prompt and exit without calling LLM'),
) -> None:
    """Aggregate evidence across all papers for a variant.

    Reads extraction results from assessments/{variant_id}/extractions/,
    variant details from variant_details.json, and paper metadata from
    papers/{doi}/metadata.json. Calls LLM for aggregate assessment and
    stores result to assessments/{variant_id}/aggregate.json.

    Model is configured via FLOWA_MODEL environment variable.
    """
    model = os.environ.get('FLOWA_MODEL')
    if not model:
        log.error('FLOWA_MODEL environment variable not set')
        raise typer.Exit(1)

    aggregate_url = assessment_url(variant_id, 'aggregate.json')
    aggregate_raw_url = assessment_url(variant_id, 'aggregate_raw.json')

    # Load variant details and query data (stored by query command)
    variant_details = json.dumps(read_json(assessment_url(variant_id, 'variant_details.json')))
    query_data = read_json(assessment_url(variant_id, 'query.json'))
    dois = query_data['dois']

    # Load extractions, bbox mappings, and metadata for each paper
    evidence_extractions: list[dict[str, Any]] = []
    bbox_mappings: dict[str, dict[int, Any]] = {}
    metadata_cache: dict[str, dict[str, Any]] = {}

    for doi in dois:
        extraction_url = assessment_url(variant_id, 'extractions', f'{doi}.json')

        if not exists(extraction_url):
            log.info('Skipping %s: no extraction', doi)
            continue

        extraction_data = read_json(extraction_url)

        if not extraction_data.get('variant_discussed'):
            log.info('Skipping %s: variant not discussed', doi)
            continue

        bbox_mappings[doi] = load_bbox_mapping(doi)
        metadata = read_json(paper_url(doi, 'metadata.json'))
        metadata_cache[doi] = metadata

        evidence_extractions.append(
            {
                'doi': doi,
                'title': metadata['title'],
                'authors': metadata['authors'],
                'date': metadata['date'],
                'evidence': extraction_data['evidence'],
            }
        )

    if not evidence_extractions:
        log.warning('No papers discussed this variant - writing empty aggregate')
        write_json(aggregate_url, with_schema_version({'results': {}}, AGGREGATE_SCHEMA_VERSION))
        return

    # Generate paper_ids and replace DOIs with human-readable IDs for the LLM
    paper_id_to_doi, doi_to_paper_id = generate_paper_ids(evidence_extractions)

    for entry in evidence_extractions:
        entry['paper_id'] = doi_to_paper_id[entry.pop('doi')]

    # Sort by date descending (most recent first)
    evidence_extractions.sort(key=lambda x: x['date'], reverse=True)

    log.info('Aggregating evidence from %d papers (model: %s)', len(evidence_extractions), model)

    # Load prompt and schema from prompt set
    prompt_template, output_type = load_prompt('aggregate')

    prompt = prompt_template.format(
        variant_details=variant_details,
        evidence_extractions=json.dumps(evidence_extractions, indent=2),
    )

    if dry_run:
        print('=== PROMPT ===')
        print(prompt)
        print('\n=== BBOX MAPPINGS (DOIs with box counts) ===')
        for doi, boxes in bbox_mappings.items():
            print(f'  {doi}: {len(boxes)} boxes (ids: {min(boxes)}..{max(boxes)})')
        print('\n=== PAPER ID MAPPING ===')
        for pid, doi in paper_id_to_doi.items():
            print(f'  {pid} -> {doi}')
        return

    # Create agent with citation validation (resolves paper_id -> DOI -> bbox)
    agent = create_aggregate_agent(model, paper_id_to_doi, bbox_mappings, output_type)

    log.info('Calling LLM for aggregate assessment')
    result = agent.run_sync(prompt)

    # Post-LLM: replace paper_id with DOI in citations, enrich with bbox info
    aggregate_dict = result.output.model_dump()
    for cat_result in aggregate_dict['results'].values():
        for citation in cat_result['citations']:
            doi = paper_id_to_doi[citation.pop('paper_id')]
            citation['doi'] = doi
            box_id = citation['box_id']
            bbox_info = bbox_mappings[doi][box_id]
            citation['page'] = bbox_info['page']
            citation['bbox'] = bbox_info['bbox']
            if 'coord_origin' in bbox_info:
                citation['coord_origin'] = bbox_info['coord_origin']

    # Add paper_id_mapping so the UI can cross-reference prose with papers
    aggregate_dict['paper_id_mapping'] = {
        pid: {'doi': doi, 'pmid': metadata_cache[doi].get('pmid')}
        for pid, doi in paper_id_to_doi.items()
    }

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
