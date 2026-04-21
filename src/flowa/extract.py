"""Extract evidence from a single paper via LLM."""

import asyncio
import json
import logging
import time

import typer
from pydantic import BaseModel
from pydantic_ai import Agent, NativeOutput

from flowa.models import create_model, get_thinking_settings
from flowa.prompts import load_prompt
from flowa.settings import ModelConfig, Settings
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
    model: ModelConfig,
    output_type: type[BaseModel],
) -> Agent[None, BaseModel]:
    """Create a Pydantic AI agent for evidence extraction."""
    return Agent(
        create_model(model),
        output_type=NativeOutput(output_type),
        retries=3,
        model_settings=get_thinking_settings(model, 'extraction'),
    )


async def extract_paper_async(
    base: str,
    variant_id: str,
    doi: str,
    model: ModelConfig,
    prompt_set: str = 'generic',
) -> None:
    """Extract evidence from a single paper via LLM."""
    encoded = encode_doi(doi)
    extraction_url = assessment_url(base, variant_id, 'extractions', f'{encoded}.json')
    extraction_raw_url = assessment_url(base, variant_id, 'extractions', f'{encoded}_raw.json')

    if exists(extraction_url):
        log.info('Already extracted: %s', extraction_url)
        return

    # Load markdown - skip if not available
    try:
        markdown = read_text(paper_url(base, doi, 'markdown.md'))
    except FileNotFoundError:
        log.info('Skipping %s: markdown.md not available', doi)
        return

    # Load variant details (stored by query command)
    variant_details = json.dumps(read_json(assessment_url(base, variant_id, 'variant_details.json')))

    full_text = truncate_paper_text(markdown, doi)

    # Load prompt and schema from prompt set
    prompt_template, output_type = load_prompt('extraction', prompt_set)

    prompt = prompt_template.format(
        variant_details=variant_details,
        full_text=full_text,
    )

    agent = create_extraction_agent(model, output_type)

    log.info('Extracting %s (%d chars, model: %s)', doi, len(full_text), model.name)
    t0 = time.monotonic()
    result = await agent.run(prompt)
    elapsed = time.monotonic() - t0

    # Store structured extraction result
    write_json(extraction_url, result.output.model_dump())

    # Store raw LLM conversation for debugging
    write_bytes(extraction_raw_url, result.all_messages_json())

    log.info(
        'Extracted %s: variant_discussed=%s, %d claims in %.1fs',
        doi,
        result.output.variant_discussed,  # type: ignore[attr-defined]
        len(result.output.claims),  # type: ignore[attr-defined]
        elapsed,
    )


def extract_paper(
    variant_id: str = typer.Option(..., '--variant-id', help='Variant identifier'),
    doi: str = typer.Option(..., '--doi', help='DOI of the paper'),
) -> None:
    """Extract evidence from a single paper via LLM.

    Reads markdown.md from papers/{encoded_doi}/ and variant_details.json from
    assessments/{variant_id}/, calls LLM for extraction, stores result to
    assessments/{variant_id}/extractions/{encoded_doi}.json.
    """
    s = Settings()  # type: ignore[call-arg]
    asyncio.run(
        extract_paper_async(s.flowa_storage_base, variant_id, doi, s.flowa_extraction_model, s.flowa_prompt_set)
    )
