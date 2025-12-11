"""Extract evidence from a single paper via LLM."""

import json
import logging
import os
from pathlib import Path
from typing import Any

import typer
from pydantic import BaseModel, Field
from pydantic_ai import Agent, ModelRetry, RunContext

from flowa.docling import serialize_with_bbox_ids
from flowa.models import create_model, get_thinking_settings
from flowa.storage import assessment_url, exists, paper_url, read_json, write_bytes, write_json

log = logging.getLogger(__name__)

# Maximum tokens per paper (heuristic: 1 token ≈ 4 chars)
MAX_PAPER_TOKENS = 60000
MAX_PAPER_CHARS = MAX_PAPER_TOKENS * 4


# Pydantic models for structured output
class Citation(BaseModel):
    """A citation to a specific bbox in the source document."""

    box_id: int = Field(description='The bounding box ID from the source text')
    commentary: str = Field(
        description='What this specific text states/demonstrates (appears as annotation in highlighted PDF)'
    )


class EvidenceFinding(BaseModel):
    """A specific factual finding from the paper."""

    finding: str = Field(description='A specific factual claim about the variant from the paper')
    citations: list[Citation] = Field(description='Citations supporting this finding', min_length=1)


class ExtractionResult(BaseModel):
    """Result of evidence extraction from a single paper."""

    variant_discussed: bool = Field(description='Whether this specific variant is discussed in the paper')
    evidence: list[EvidenceFinding] = Field(description='List of evidence findings extracted from the paper')


def truncate_paper_text(full_text: str, pmid: int) -> str:
    """Truncate paper text if it exceeds MAX_PAPER_CHARS."""
    if len(full_text) <= MAX_PAPER_CHARS:
        return full_text

    log.warning('Paper %s exceeds %d tokens (%d chars) - truncating', pmid, MAX_PAPER_TOKENS, len(full_text))

    truncation_note = '\n\n[NOTE: This paper was truncated due to length.]'
    available_chars = MAX_PAPER_CHARS - len(truncation_note)
    return full_text[:available_chars] + truncation_note


def create_extraction_agent(model: str, bbox_mapping: dict[int, Any]) -> Agent[None, ExtractionResult]:
    """Create a Pydantic AI agent with citation validation."""
    agent: Agent[None, ExtractionResult] = Agent(
        create_model(model),
        output_type=ExtractionResult,
        retries=3,
        model_settings=get_thinking_settings(model, 'extraction'),
    )

    @agent.output_validator
    def validate_citations(ctx: RunContext[None], result: ExtractionResult) -> ExtractionResult:
        """Validate that all citation box_ids exist in bbox_mapping."""
        invalid = []

        for finding in result.evidence:
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

    # Load prompt template
    prompts_dir = Path('prompts')
    prompt_template = (prompts_dir / 'individual_extraction_prompt.txt').read_text()

    prompt = prompt_template.format(
        variant_details=variant_details,
        pmid=pmid,
        full_text=full_text,
    )

    # Create agent with citation validation
    agent = create_extraction_agent(model, bbox_mapping)

    log.info('Calling LLM for extraction')
    result = agent.run_sync(prompt)

    # Store structured extraction result
    write_json(extraction_url, result.output.model_dump())

    # Store raw LLM conversation for debugging
    write_bytes(extraction_raw_url, result.all_messages_json())

    log.info(
        'Extracted PMID %s: variant_discussed=%s, %d findings',
        pmid,
        result.output.variant_discussed,
        len(result.output.evidence),
    )
