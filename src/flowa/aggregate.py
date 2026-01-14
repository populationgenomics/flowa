"""Aggregate evidence across all papers for a variant."""

import json
import logging
import os
from typing import Any

import typer
from pydantic import BaseModel
from pydantic_ai import Agent, ModelRetry, RunContext

from flowa.docling import load_bbox_mapping
from flowa.models import create_model, get_thinking_settings
from flowa.prompts import load_model, load_prompt
from flowa.schema import AGGREGATE_SCHEMA_VERSION, with_schema_version
from flowa.storage import assessment_url, exists, paper_url, read_json, write_bytes, write_json

log = logging.getLogger(__name__)


def create_aggregate_agent(
    model: str,
    bbox_mappings: dict[int, dict[int, Any]],
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
        """Validate that all citation (pmid, box_id) pairs exist.

        Requires: result.results[category].citations[].pmid and .box_id
        """
        invalid = []

        for category, cat_result in result.results.items():  # type: ignore[attr-defined]
            for citation in cat_result.citations:
                pmid = citation.pmid
                if pmid not in bbox_mappings:
                    invalid.append(f'pmid={pmid} (paper not found)')
                elif citation.box_id not in bbox_mappings[pmid]:
                    invalid.append(f'pmid={pmid}, box_id={citation.box_id}, category={category}')

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
    papers/{pmid}/metadata.json. Calls LLM for aggregate assessment and
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
    pmids = query_data['pmids']

    # Load extractions and build evidence list
    evidence_extractions = []
    bbox_mappings: dict[int, dict[int, Any]] = {}

    for pmid in pmids:
        extraction_url = assessment_url(variant_id, 'extractions', f'{pmid}.json')

        # Skip if extraction doesn't exist (paper wasn't processed)
        if not exists(extraction_url):
            log.info('Skipping PMID %s: no extraction', pmid)
            continue

        # Load extraction
        extraction_data = read_json(extraction_url)

        # Skip papers where variant was not discussed
        if not extraction_data.get('variant_discussed'):
            log.info('Skipping PMID %s: variant not discussed', pmid)
            continue

        # Load bbox mapping on-the-fly from docling.json
        bbox_mappings[pmid] = load_bbox_mapping(pmid)

        # Load PubMed metadata (stored by download command)
        metadata = read_json(paper_url(pmid, 'metadata.json'))

        evidence_extractions.append(
            {
                'pmid': int(pmid),
                'title': metadata['title'],
                'authors': metadata['authors'],
                'date': metadata['date'],
                'evidence': extraction_data['evidence'],
            }
        )

    if not evidence_extractions:
        log.error('No papers discussed this variant - cannot aggregate')
        raise typer.Exit(1)

    # Sort by PMID descending (most recent/highest first)
    evidence_extractions.sort(key=lambda x: x['pmid'], reverse=True)

    log.info('Aggregating evidence from %d papers (model: %s)', len(evidence_extractions), model)

    # Load prompt and schema from prompt set
    prompt_template = load_prompt('aggregate_prompt')
    output_type = load_model('aggregate_schema', 'AggregateResult')

    prompt = prompt_template.format(
        variant_details=variant_details,
        evidence_extractions=json.dumps(evidence_extractions, indent=2),
    )

    if dry_run:
        print('=== PROMPT ===')
        print(prompt)
        print('\n=== BBOX MAPPINGS (PMIDs with box counts) ===')
        for pmid, boxes in bbox_mappings.items():
            print(f'  {pmid}: {len(boxes)} boxes (ids: {min(boxes)}..{max(boxes)})')
        return

    # Create agent with citation validation
    agent = create_aggregate_agent(model, bbox_mappings, output_type)

    log.info('Calling LLM for aggregate assessment')
    result = agent.run_sync(prompt)

    # Enrich citations with bbox info from bbox_mappings
    aggregate_dict = result.output.model_dump()
    for cat_result in aggregate_dict['results'].values():
        for citation in cat_result['citations']:
            pmid = citation['pmid']
            box_id = citation['box_id']
            bbox_info = bbox_mappings[pmid][box_id]
            citation['page'] = bbox_info['page']
            citation['bbox'] = bbox_info['bbox']
            if 'coord_origin' in bbox_info:
                citation['coord_origin'] = bbox_info['coord_origin']

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
