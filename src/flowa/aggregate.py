"""Aggregate evidence across all papers for a variant."""

import asyncio
import json
import logging
import re
import time
from typing import Any

import logfire
import typer
from pydantic import BaseModel
from pydantic_ai import Agent, ModelRetry, NativeOutput, RunContext

from flowa.clinvar import format_clinvar_for_prompt, query_clinvar
from flowa.models import create_model, get_model_settings
from flowa.prompts import load_prompt_and_schema
from flowa.resolve import CitationQuery, load_pdf_index_from_storage, resolve_citations
from flowa.schema import AGGREGATION_SCHEMA_VERSION, with_schema_version
from flowa.settings import ModelConfig, Settings
from flowa.storage import (
    assessment_url,
    encode_doi,
    exists,
    paper_url,
    read_json,
    write_bytes,
    write_json,
)

log = logging.getLogger(__name__)

# Cap for thinking + structured-output combined; matches Sonnet 4.6's max output.
_AGGREGATE_MAX_TOKENS = 64_000


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


# One counter per rule label — lets us see how often aggregation's LLM
# produces shape-invalid output and which rule it trips on. Logfire is
# configured in cli.py; when it isn't (tests), the counter is a no-op.
_aggregate_retry_counter = logfire.metric_counter(
    'flowa_aggregate_validation_errors_total',
    description='Shape-validation rule violations found by the aggregate output_validator',
)


def create_aggregate_agent(
    model: ModelConfig,
    paper_id_to_doi: dict[str, str],
    output_type: type[BaseModel],
) -> Agent[None, BaseModel]:
    """Create a Pydantic AI agent with paper_id validation."""
    agent: Agent[None, BaseModel] = Agent(
        create_model(model),
        output_type=NativeOutput(output_type),
        retries=3,
        model_settings=get_model_settings(model, effort='medium', max_tokens=_AGGREGATE_MAX_TOKENS),
    )

    @agent.output_validator
    def validate_shape(ctx: RunContext[None], result: BaseModel) -> BaseModel:
        """Shape-only validation: paper_id membership + group integrity.

        Semantic cross-field checks (citation fidelity, grouping order) live in
        chat-service — every artifact mutation flows through it, so the rules
        stay authored in one place.
        """
        errors: list[str] = []

        for cat_result in result.results:  # type: ignore[attr-defined]
            code = getattr(cat_result, 'code', '<unknown>')
            paper_ids_in_papers = [p.paper_id for p in cat_result.papers]
            paper_ids_set = set(paper_ids_in_papers)

            if len(paper_ids_in_papers) != len(paper_ids_set):
                duplicates = [pid for pid in paper_ids_set if paper_ids_in_papers.count(pid) > 1]
                errors.append(f'code={code}: papers[] has duplicate paper_ids: {sorted(duplicates)}')
                _aggregate_retry_counter.add(1, {'rule': 'paper_id_duplicate'})

            for paper in cat_result.papers:
                if paper.paper_id not in paper_id_to_doi:
                    errors.append(f'code={code}: papers[] has unknown paper_id={paper.paper_id}')
                    _aggregate_retry_counter.add(1, {'rule': 'paper_id_unknown'})

            for claim in cat_result.claims:
                if claim.paper_id not in paper_ids_set:
                    errors.append(f'code={code}: claim cites paper_id={claim.paper_id} not present in papers[]')
                    _aggregate_retry_counter.add(1, {'rule': 'claim_paper_missing'})

        if errors:
            raise ModelRetry('Invalid aggregate output: ' + '; '.join(errors))

        return result

    return agent


def resolve_aggregate_citations(
    aggregate_dict: dict[str, Any],
    paper_id_to_doi: dict[str, str],
    base: str,
    metadata_cache: dict[str, dict[str, Any]],
) -> None:
    """Post-process aggregate output: resolve quotes to bboxes on claim citations.

    Loads each paper's pre-built `pdf_index.pkl.zst` via the same path the
    gateway uses; the convert step that ran earlier in this pipeline wrote
    the artifact, so it's guaranteed to be present.
    """
    # Collect all (doi, quote) pairs, grouped by DOI.
    doi_quotes: dict[str, list[str]] = {}
    for cat_result in aggregate_dict['results']:
        for claim in cat_result['claims']:
            doi = paper_id_to_doi[claim['paper_id']]
            for citation in claim['citations']:
                doi_quotes.setdefault(doi, []).append(citation['quote'])

    citations_input = [CitationQuery(doi=doi, quotes=quotes) for doi, quotes in doi_quotes.items()]
    result = resolve_citations(
        citations_input,
        index_provider=lambda doi: load_pdf_index_from_storage(base, doi),
    )

    # Attach resolved bboxes onto each claim's citations.
    for cat_result in aggregate_dict['results']:
        for claim in cat_result['claims']:
            doi = paper_id_to_doi[claim['paper_id']]
            for citation in claim['citations']:
                quote = citation['quote']
                bboxes = result.resolved.get(doi, {}).get(quote, [])
                citation['bboxes'] = [b.model_dump() for b in bboxes]
                if not bboxes:
                    log.warning('No bboxes resolved for %s quote: %.80s...', doi, quote)

    # Add paper_id_mapping: {AuthorYear -> {doi, pmid}} for cross-referencing
    # prose citations with papers. Consumers build the reverse index on read.
    aggregate_dict['paper_id_mapping'] = {
        pid: {'doi': doi, 'pmid': metadata_cache[doi].get('pmid')} for pid, doi in paper_id_to_doi.items()
    }


async def aggregate_evidence_async(
    base: str,
    variant_id: str,
    model: ModelConfig,
    ncbi_api_key: str | None = None,
    prompt_set: str = 'generic',
    dry_run: bool = False,
) -> None:
    """Aggregate evidence across all papers for a variant."""
    aggregation_url = assessment_url(base, variant_id, 'aggregation.json')
    aggregation_raw_url = assessment_url(base, variant_id, 'aggregation_raw.json')

    # Load variant details and query data (stored by query command)
    variant_details = json.dumps(read_json(assessment_url(base, variant_id, 'variant_details.json')))
    query_data = read_json(assessment_url(base, variant_id, 'query.json'))
    dois = query_data['dois']

    # Reconstruct the colon-glued HGVS c. expression for ClinVar exact-phrase
    # search. The variant_spec persisted here carries `transcript` and `hgvs_c`
    # as separate fields; downstream callers join them at the use site.
    spec_item = query_data['variant_spec']['variants'][0]
    hgvs_c_full = f'{spec_item["transcript"]}:{spec_item["hgvs_c"]}'

    # Fetch ClinVar evidence
    clinvar_data = query_clinvar(hgvs_c_full, ncbi_api_key)
    clinvar_text = format_clinvar_for_prompt(clinvar_data)

    # Load extractions and metadata for each paper. PDF bytes and markdown
    # are NOT loaded here — the post-LLM citation resolver loads the paper's
    # pre-built `pdf_index.pkl.zst` directly from storage, so this step only
    # needs the LLM inputs.
    evidence_extractions: list[dict[str, Any]] = []
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

        metadata = read_json(paper_url(base, doi, 'metadata.json'))
        metadata_cache[doi] = metadata

        # Support both new-shape ('claims') and legacy ('evidence') extractions for
        # backfill convenience — the schema renamed EvidenceFinding -> Claim and
        # dropped commentary, but we still want to consume older extraction JSON.
        claims = extraction_data.get('claims')
        if claims is None:
            legacy = extraction_data.get('evidence', [])
            claims = [
                {
                    'text': item.get('finding', ''),
                    'citations': [{'quote': c['quote']} for c in item.get('citations', [])],
                }
                for item in legacy
            ]

        entry: dict[str, Any] = {
            'doi': doi,
            'title': metadata['title'],
            'authors': metadata['authors'],
            'date': metadata['date'],
            'claims': claims,
        }
        if metadata.get('pmid'):
            entry['pmid'] = metadata['pmid']
        evidence_extractions.append(entry)

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
        model.name,
    )

    # Load prompt and schema from prompt set
    prompt_template, output_type = load_prompt_and_schema('aggregation', prompt_set)

    evidence_text = (
        json.dumps(evidence_extractions, indent=2)
        if evidence_extractions
        else 'No papers discussing this variant were found.'
    )
    prompt = prompt_template.render(
        variant_details=variant_details,
        clinvar_data=clinvar_text,
        evidence_extractions=evidence_text,
    )

    if dry_run:
        print('=== PROMPT ===')
        print(prompt)
        print('\n=== PAPER ID MAPPING ===')
        for pid, doi in paper_id_to_doi.items():
            print(f'  {pid} -> {doi}')
        return

    agent = create_aggregate_agent(model, paper_id_to_doi, output_type)

    log.info('Calling LLM for aggregate assessment')
    t0 = time.monotonic()
    # Stream so bytes flow during extended thinking; otherwise the connection
    # goes silent for many minutes and trips our Bedrock read_timeout.
    async with agent.run_stream(prompt) as stream_result:
        output = await stream_result.get_output()
        raw_messages_json = stream_result.all_messages_json()
    elapsed = time.monotonic() - t0

    # Post-LLM: resolve quotes to bboxes, replace paper_id with DOI
    aggregate_dict = output.model_dump()
    with logfire.span('flowa.resolve_citations', paper_count=len(paper_id_to_doi)):
        resolve_aggregate_citations(aggregate_dict, paper_id_to_doi, base, metadata_cache)

    # Store structured aggregation result
    write_json(aggregation_url, with_schema_version(aggregate_dict, AGGREGATION_SCHEMA_VERSION))

    # Store raw LLM conversation for debugging
    write_bytes(aggregation_raw_url, raw_messages_json)

    results_list = output.results  # type: ignore[attr-defined]
    total_claims = sum(len(cat_result.claims) for cat_result in results_list)
    total_papers = sum(len(cat_result.papers) for cat_result in results_list)
    log.info(
        'Aggregated variant %s: %d categories, %d claims across %d papers in %.1fs',
        variant_id,
        len(results_list),
        total_claims,
        total_papers,
        elapsed,
    )


def aggregate_evidence(
    variant_id: str = typer.Option(..., '--variant-id', help='Variant identifier'),
    dry_run: bool = typer.Option(False, '--dry-run', help='Dump prompt and exit without calling LLM'),
) -> None:
    """Aggregate evidence across all papers for a variant.

    Reads extraction results from assessments/{variant_id}/extractions/,
    variant details from variant_details.json, and paper metadata from
    papers/{encoded_doi}/metadata.json. Calls LLM for aggregate assessment and
    stores result to assessments/{variant_id}/aggregation.json.
    """
    s = Settings()  # type: ignore[call-arg]
    asyncio.run(
        aggregate_evidence_async(
            s.flowa_storage_base, variant_id, s.flowa_extraction_model, s.ncbi_api_key, s.flowa_prompt_set, dry_run
        )
    )
