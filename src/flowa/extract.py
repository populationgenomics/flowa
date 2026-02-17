"""Extract evidence from a single paper via LLM."""

import json
import logging
import os
from typing import Any

import typer
from pydantic import BaseModel
from pydantic_ai import Agent, ModelRetry, RunContext

from flowa.docling import serialize_with_bbox_ids
from flowa.models import create_model, get_thinking_settings
from flowa.prompts import load_prompt
from flowa.storage import assessment_url, exists, paper_url, read_json, write_bytes, write_json

log = logging.getLogger(__name__)

# Maximum tokens per paper (heuristic: 1 token ≈ 4 chars)
MAX_PAPER_TOKENS = 60000
MAX_PAPER_CHARS = MAX_PAPER_TOKENS * 4


def truncate_paper_text(full_text: str, pmid: int) -> str:
    """Truncate paper text if it exceeds MAX_PAPER_CHARS."""
    if len(full_text) <= MAX_PAPER_CHARS:
        return full_text

    log.warning('Paper %s exceeds %d tokens (%d chars) - truncating', pmid, MAX_PAPER_TOKENS, len(full_text))

    truncation_note = '\n\n[NOTE: This paper was truncated due to length.]'
    available_chars = MAX_PAPER_CHARS - len(truncation_note)
    return full_text[:available_chars] + truncation_note


def create_extraction_agent(
    model: str,
    bbox_mapping: dict[int, Any],
    output_type: type[BaseModel],
) -> Agent[None, BaseModel]:
    """Create a Pydantic AI agent with citation validation."""
    agent: Agent[None, BaseModel] = Agent(
        create_model(model),
        output_type=output_type,
        retries=3,
        model_settings=get_thinking_settings(model, 'extraction'),
    )

    @agent.output_validator
    def validate_citations(ctx: RunContext[None], result: BaseModel) -> BaseModel:
        """Validate that all citation box_ids exist in bbox_mapping.

        Requires: result.evidence[].citations[].box_id
        """
        invalid = []

        for finding in result.evidence:  # type: ignore[attr-defined]
            for citation in finding.citations:
                if citation.box_id not in bbox_mapping:
                    invalid.append(f'box_id={citation.box_id}')

        if invalid:
            raise ModelRetry(f'Invalid box_ids not found in document: {", ".join(invalid)}')

        return result

    return agent


def extract_paper(
    variant_id: str = typer.Option(..., '--variant-id', help='Variant identifier'),
    pmid: int = typer.Option(..., '--pmid', help='PubMed ID to extract'),
) -> None:
    """Extract evidence from a single paper via LLM.

    Reads docling.json from papers/{pmid}/ and variant_details.json from
    assessments/{variant_id}/, calls LLM for extraction, stores result to
    assessments/{variant_id}/extractions/{pmid}.json.

    Model is configured via FLOWA_MODEL environment variable.
    """
    model = os.environ.get('FLOWA_MODEL')
    if not model:
        log.error('FLOWA_MODEL environment variable not set')
        raise typer.Exit(1)

    extraction_url = assessment_url(variant_id, 'extractions', f'{pmid}.json')
    extraction_raw_url = assessment_url(variant_id, 'extractions', f'{pmid}_raw.json')

    # Check if already extracted
    if exists(extraction_url):
        log.info('Already extracted: %s', extraction_url)
        return

    # Load docling JSON - skip if not available
    try:
        docling_json = read_json(paper_url(pmid, 'docling.json'))
    except FileNotFoundError:
        log.info('Skipping PMID %s: docling.json not available', pmid)
        return

    # Load variant details (stored by query command)
    variant_details = json.dumps(read_json(assessment_url(variant_id, 'variant_details.json')))

    log.info('Extracting evidence from PMID %s (model: %s)', pmid, model)

    # Serialize to markdown with bbox IDs
    full_text, bbox_mapping = serialize_with_bbox_ids(docling_json)
    full_text = truncate_paper_text(full_text, pmid)

    # Load prompt and schema from prompt set
    prompt_template, output_type = load_prompt('extraction')

    prompt = prompt_template.format(
        variant_details=variant_details,
        pmid=pmid,
        full_text=full_text,
    )

    # Create agent with citation validation
    agent = create_extraction_agent(model, bbox_mapping, output_type)

    log.info('Calling LLM for extraction')
    result = agent.run_sync(prompt)

    # Store structured extraction result
    write_json(extraction_url, result.output.model_dump())

    # Store raw LLM conversation for debugging
    write_bytes(extraction_raw_url, result.all_messages_json())

    log.info(
        'Extracted PMID %s: variant_discussed=%s, %d findings',
        pmid,
        result.output.variant_discussed,  # type: ignore[attr-defined]
        len(result.output.evidence),  # type: ignore[attr-defined]
    )
