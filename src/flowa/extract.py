"""Extract evidence from a single paper via LLM."""

import asyncio
import json
import logging

import typer
from anchorite import resolve, strip
from pydantic import BaseModel
from pydantic_ai import Agent, ModelRetry, RunContext

from flowa.models import create_model, get_thinking_settings
from flowa.prompts import load_prompt
from flowa.settings import Settings
from flowa.storage import assessment_url, encode_doi, exists, paper_url, read_json, read_text, write_bytes, write_json

log = logging.getLogger(__name__)

# Maximum tokens per paper (heuristic: 1 token ≈ 4 chars)
MAX_PAPER_TOKENS = 60000
MAX_PAPER_CHARS = MAX_PAPER_TOKENS * 4


def truncate_paper_text(full_text: str, doi: str) -> str:
    """Truncate paper text if it exceeds MAX_PAPER_CHARS."""
    if len(full_text) <= MAX_PAPER_CHARS:
        return full_text

    log.warning('Paper %s exceeds %d tokens (%d chars) - truncating', doi, MAX_PAPER_TOKENS, len(full_text))

    truncation_note = '\n\n[NOTE: This paper was truncated due to length.]'
    available_chars = MAX_PAPER_CHARS - len(truncation_note)
    return full_text[:available_chars] + truncation_note


def create_extraction_agent(
    model: str,
    annotated_md: str,
    output_type: type[BaseModel],
) -> Agent[None, BaseModel]:
    """Create a Pydantic AI agent with citation validation."""
    agent: Agent[None, BaseModel] = Agent(
        create_model(model),
        output_type=output_type,
        retries=3,
        instructions='Always return your response by calling the final_result tool.',
        model_settings=get_thinking_settings(model, 'extraction'),
    )

    @agent.output_validator
    def validate_citations(ctx: RunContext[None], result: BaseModel) -> BaseModel:
        """Validate that all citation quotes can be resolved in annotated_md.

        Requires: result.evidence[].citations[].quote
        """
        all_quotes = [
            citation.quote
            for finding in result.evidence  # type: ignore[attr-defined]
            for citation in finding.citations
        ]
        if not all_quotes:
            return result

        resolved = resolve(annotated_md, all_quotes)

        unresolved = [q for q in all_quotes if not resolved.get(q)]
        if unresolved:
            raise ModelRetry(
                f'These quotes could not be resolved against the paper text '
                f'(not found verbatim, or too short/generic to align unambiguously): '
                f'{unresolved}'
            )

        return result

    return agent


async def extract_paper_async(
    base: str,
    variant_id: str,
    doi: str,
    model: str,
    prompt_set: str = 'generic',
) -> None:
    """Extract evidence from a single paper via LLM."""
    encoded = encode_doi(doi)
    extraction_url = assessment_url(base, variant_id, 'extractions', f'{encoded}.json')
    extraction_raw_url = assessment_url(base, variant_id, 'extractions', f'{encoded}_raw.json')

    if exists(extraction_url):
        log.info('Already extracted: %s', extraction_url)
        return

    # Load annotated markdown - skip if not available
    try:
        annotated_md = read_text(paper_url(base, doi, 'annotated.md'))
    except FileNotFoundError:
        log.info('Skipping %s: annotated.md not available', doi)
        return

    # Load variant details (stored by query command)
    variant_details = json.dumps(read_json(assessment_url(base, variant_id, 'variant_details.json')))

    log.info('Extracting evidence from %s (model: %s)', doi, model)

    # Strip annotation spans to get clean markdown for LLM prompt
    stripped = strip(annotated_md)
    full_text = truncate_paper_text(stripped.plain_text, doi)

    # Load prompt and schema from prompt set
    prompt_template, output_type = load_prompt('extraction', prompt_set)

    prompt = prompt_template.format(
        variant_details=variant_details,
        full_text=full_text,
    )

    # Create agent with citation validation
    agent = create_extraction_agent(model, annotated_md, output_type)

    log.info('Calling LLM for extraction')
    result = await agent.run(prompt)

    # Store structured extraction result
    write_json(extraction_url, result.output.model_dump())

    # Store raw LLM conversation for debugging
    write_bytes(extraction_raw_url, result.all_messages_json())

    log.info(
        'Extracted %s: variant_discussed=%s, %d findings',
        doi,
        result.output.variant_discussed,  # type: ignore[attr-defined]
        len(result.output.evidence),  # type: ignore[attr-defined]
    )


def extract_paper(
    variant_id: str = typer.Option(..., '--variant-id', help='Variant identifier'),
    doi: str = typer.Option(..., '--doi', help='DOI of the paper'),
) -> None:
    """Extract evidence from a single paper via LLM.

    Reads annotated.md from papers/{encoded_doi}/ and variant_details.json from
    assessments/{variant_id}/, calls LLM for extraction, stores result to
    assessments/{variant_id}/extractions/{encoded_doi}.json.
    """
    s = Settings()  # type: ignore[call-arg]
    asyncio.run(
        extract_paper_async(s.flowa_storage_base, variant_id, doi, s.flowa_extraction_model, s.flowa_prompt_set)
    )
