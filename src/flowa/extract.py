"""Extract evidence from a single paper via LLM."""

import asyncio
import json
import logging
import time

import typer
from pydantic import BaseModel
from pydantic_ai import Agent, NativeOutput

from flowa.models import create_model, get_model_settings
from flowa.prompts import load_prompt_and_schema
from flowa.settings import ModelConfig, Settings
from flowa.storage import assessment_url, encode_doi, exists, paper_url, read_json, read_text, write_bytes, write_json

log = logging.getLogger(__name__)

# Maximum tokens per paper (heuristic: 1 token ≈ 4 chars). Sized for markdown.md
# = main paper + appended supplements; the build-time per-paper supplement budget
# (flowa.assemble) is the primary gate, this is the safety net for oversized input.
MAX_PAPER_TOKENS = 100000
MAX_PAPER_CHARS = MAX_PAPER_TOKENS * 4

# Cap for thinking + structured-output combined; matches Sonnet 4.6's max output.
_EXTRACT_MAX_TOKENS = 64_000


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
        model_settings=get_model_settings(model, effort='medium', max_tokens=_EXTRACT_MAX_TOKENS),
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
    prompt_template, output_type = load_prompt_and_schema('extraction', prompt_set)

    prompt = prompt_template.render(
        variant_details=variant_details,
        full_text=full_text,
    )

    agent = create_extraction_agent(model, output_type)

    log.info('Extracting %s (%d chars, model: %s)', doi, len(full_text), model.name)
    t0 = time.monotonic()
    # Stream so bytes flow during extended thinking; otherwise the connection
    # goes silent for many minutes and trips our Bedrock read_timeout.
    async with agent.run_stream(prompt) as stream_result:
        output = await stream_result.get_output()
        raw_messages_json = stream_result.all_messages_json()
    elapsed = time.monotonic() - t0

    # Store structured extraction result
    write_json(extraction_url, output.model_dump())

    # Store raw LLM conversation for debugging
    write_bytes(extraction_raw_url, raw_messages_json)

    log.info(
        'Extracted %s: variant_discussed=%s, %d claims in %.1fs',
        doi,
        output.variant_discussed,  # type: ignore[attr-defined]
        len(output.claims),  # type: ignore[attr-defined]
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
