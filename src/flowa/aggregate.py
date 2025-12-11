"""Aggregate evidence across all papers for a variant."""

import json
import logging
import os
from pathlib import Path
from typing import Any

import typer
from pydantic import BaseModel, Field
from pydantic_ai import Agent, ModelRetry, RunContext

from flowa.docling import load_bbox_mapping
from flowa.models import create_model, get_thinking_settings
from flowa.storage import assessment_url, exists, paper_url, read_json, write_bytes, write_json

log = logging.getLogger(__name__)


# Pydantic models for structured output
class AggregateCitation(BaseModel):
    """A citation to a specific bbox in a source paper."""

    pmid: int = Field(description='PubMed ID of the source paper')
    box_id: int = Field(description='The bounding box ID from the source text in the paper')
    commentary: str = Field(description='What this specific evidence states (appears as annotation in highlighted PDF)')


class AggregateResult(BaseModel):
    """Result of aggregate assessment across all papers."""

    classification: str = Field(
        description='ACMG classification: Pathogenic, Likely Pathogenic, VUS, Likely Benign, or Benign'
    )
    classification_rationale: str = Field(description='Brief explanation of why this classification was selected')
    description: str = Field(description='The mandatory template filled in with specific details from the evidence')
    notes: str = Field(description='Detailed curator-style synthesis in Markdown format')
    citations: list[AggregateCitation] = Field(
        description='All citations supporting factual claims in the detailed notes'
    )


def create_aggregate_agent(
    model: str,
    bbox_mappings: dict[int, dict[int, Any]],
) -> Agent[None, AggregateResult]:
    """Create a Pydantic AI agent with citation validation across all papers."""
    agent: Agent[None, AggregateResult] = Agent(
        create_model(model),
        output_type=AggregateResult,
        retries=3,
        model_settings=get_thinking_settings(model, 'aggregation'),
    )

    @agent.output_validator
    def validate_citations(ctx: RunContext[None], result: AggregateResult) -> AggregateResult:
        """Validate that all citation (pmid, box_id) pairs exist."""
        invalid = []

        for citation in result.citations:
            pmid = citation.pmid
            if pmid not in bbox_mappings:
                invalid.append(f'pmid={pmid} (paper not found)')
            elif citation.box_id not in bbox_mappings[pmid]:
                invalid.append(f'pmid={pmid}, box_id={citation.box_id}')

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

    # Load prompt template
    prompts_dir = Path('prompts')
    prompt_template = (prompts_dir / 'aggregate_assessment_prompt.txt').read_text()

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
    agent = create_aggregate_agent(model, bbox_mappings)

    log.info('Calling LLM for aggregate assessment')
    result = agent.run_sync(prompt)

    # Store structured aggregate result
    write_json(aggregate_url, result.output.model_dump())

    # Store raw LLM conversation for debugging
    write_bytes(aggregate_raw_url, result.all_messages_json())

    log.info(
        'Aggregated variant %s: classification=%s, %d citations',
        variant_id,
        result.output.classification,
        len(result.output.citations),
    )
