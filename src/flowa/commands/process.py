"""Process variant literature through individual extraction and aggregation."""

import json
import logging
import re
from pathlib import Path
from typing import Any, cast

import httpx
import typer
from docling_core.transforms.serializer.base import BaseDocSerializer, SerializationResult
from docling_core.transforms.serializer.common import create_ser_result
from docling_core.transforms.serializer.markdown import (
    MarkdownDocSerializer,
    MarkdownPictureSerializer,
    MarkdownTableSerializer,
    MarkdownTextSerializer,
)
from docling_core.types.doc import DoclingDocument, PictureItem, TableItem, TextItem
from metapub import PubMedFetcher  # type: ignore[import-untyped]
from openai import OpenAI
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from rich.console import Console
from rich.markdown import Markdown
from rich.panel import Panel
from rich.progress import (
    BarColumn,
    Progress,
    SpinnerColumn,
    TaskProgressColumn,
    TextColumn,
)

from flowa.db import (
    get_aggregate_assessment,
    get_all_extractions_for_variant,
    get_individual_extraction,
    get_variant,
    save_aggregate_assessment,
    save_individual_extraction,
)

# Maximum tokens per paper (heuristic: 1 token ≈ 4 chars)
MAX_PAPER_TOKENS = 60000
MAX_PAPER_CHARS = MAX_PAPER_TOKENS * 4

logger = logging.getLogger(__name__)

console = Console()


class Settings(BaseSettings):
    """Environment configuration."""

    model_config = SettingsConfigDict(env_file='.env', env_file_encoding='utf-8', extra='ignore')

    openai_api_key: str | None = None
    openai_base_url: str | None = None
    openai_model: str = 'gpt-5'


class BboxMarkdownTextSerializer(MarkdownTextSerializer):
    """Text serializer that wraps output with bbox IDs."""

    def serialize(
        self,
        *,
        item: TextItem,
        doc_serializer: BaseDocSerializer,
        doc: DoclingDocument,
        **kwargs: Any,
    ) -> SerializationResult:
        result = super().serialize(item=item, doc_serializer=doc_serializer, doc=doc, **kwargs)
        wrapped = cast('BboxMarkdownDocSerializer', doc_serializer).wrap_with_bbox(item, result.text)
        return create_ser_result(text=wrapped, span_source=[result])


class BboxMarkdownTableSerializer(MarkdownTableSerializer):
    """Table serializer that wraps output with bbox IDs."""

    def serialize(
        self,
        *,
        item: TableItem,
        doc_serializer: BaseDocSerializer,
        doc: DoclingDocument,
        **kwargs: Any,
    ) -> SerializationResult:
        result = super().serialize(item=item, doc_serializer=doc_serializer, doc=doc, **kwargs)
        wrapped = cast('BboxMarkdownDocSerializer', doc_serializer).wrap_with_bbox(item, result.text)
        return create_ser_result(text=wrapped, span_source=[result])


class BboxMarkdownPictureSerializer(MarkdownPictureSerializer):
    """Picture serializer that wraps output with bbox IDs."""

    def serialize(
        self,
        *,
        item: PictureItem,
        doc_serializer: BaseDocSerializer,
        doc: DoclingDocument,
        **kwargs: Any,
    ) -> SerializationResult:
        result = super().serialize(item=item, doc_serializer=doc_serializer, doc=doc, **kwargs)
        wrapped = cast('BboxMarkdownDocSerializer', doc_serializer).wrap_with_bbox(item, result.text)
        return create_ser_result(text=wrapped, span_source=[result])


class BboxMarkdownDocSerializer(MarkdownDocSerializer):
    """Document serializer that tracks bbox mappings and wraps items with IDs."""

    text_serializer: BboxMarkdownTextSerializer = BboxMarkdownTextSerializer()
    table_serializer: BboxMarkdownTableSerializer = BboxMarkdownTableSerializer()
    picture_serializer: BboxMarkdownPictureSerializer = BboxMarkdownPictureSerializer()

    box_id_counter: int = 1
    bbox_mapping: dict[int, dict[str, Any]] = Field(default_factory=dict)

    def wrap_with_bbox(self, item: Any, text: str) -> str:
        """
        Wrap text with bbox ID if item has provenance information and meaningful content.

        Args:
            item: Document item (TextItem, TableItem, PictureItem, etc.)
            text: Serialized text to wrap

        Returns:
            Text wrapped with <b id=N>...</b> tags if bbox available and content is meaningful,
            empty string if content is placeholder-only, otherwise unchanged
        """
        if not text:
            return text

        # Skip placeholder-only content (e.g., "<!-- image -->", "logo\n\n<!-- image -->")
        # Strip HTML comments to see if there's actual content
        text_without_comments = re.sub(r'<!--.*?-->', '', text, flags=re.DOTALL)
        if not text_without_comments.strip():
            # No actual content besides HTML comments, return empty string to skip it
            return ''

        if hasattr(item, 'prov') and item.prov:
            prov = item.prov[0]
            if hasattr(prov, 'bbox') and hasattr(prov, 'page_no'):
                box_id = self.box_id_counter
                self.box_id_counter += 1

                self.bbox_mapping[box_id] = {
                    'page': prov.page_no,
                    'bbox': {
                        'l': float(prov.bbox.l),
                        't': float(prov.bbox.t),
                        'r': float(prov.bbox.r),
                        'b': float(prov.bbox.b),
                    },
                }

                if hasattr(prov.bbox, 'coord_origin'):
                    self.bbox_mapping[box_id]['coord_origin'] = str(prov.bbox.coord_origin)

                return f'<b id={box_id}>{text}</b>'

        return text


def serialize_with_bbox_ids(
    docling_json_path: Path,
) -> tuple[str, dict[int, dict[str, Any]]]:
    """
    Serialize Docling JSON document to token-efficient text with bbox IDs.

    Args:
        docling_json_path: Path to Docling JSON file

    Returns:
        Tuple of (serialized_text, bbox_mapping_dict)

    The bbox_mapping_dict maps box_id to:
    {
        "page": page_number,
        "bbox": {"l": left, "t": top, "r": right, "b": bottom}
    }
    """
    logger.debug(f'Loading Docling document from {docling_json_path}')

    # Load the Docling document
    doc = DoclingDocument.load_from_json(docling_json_path)

    # Create custom serializer that tracks bbox mappings
    serializer = BboxMarkdownDocSerializer(doc=doc)
    result = serializer.serialize()

    logger.info(f'Generated serialized text with {len(serializer.bbox_mapping)} bbox IDs')

    return result.text, serializer.bbox_mapping


def truncate_paper_text(full_text: str, pmid: int) -> str:
    """Truncate paper text if it exceeds MAX_PAPER_CHARS.

    Args:
        full_text: The full paper text
        pmid: PMID for logging

    Returns:
        Truncated text with a note if truncation occurred
    """
    if len(full_text) <= MAX_PAPER_CHARS:
        return full_text

    logger.warning(
        f'Paper {pmid} exceeds {MAX_PAPER_TOKENS} tokens '
        f'({len(full_text)} chars) - truncating to {MAX_PAPER_CHARS} chars',
    )

    truncation_note = '\n\n[NOTE: This paper was truncated due to length.]'
    available_chars = MAX_PAPER_CHARS - len(truncation_note)
    return full_text[:available_chars] + truncation_note


def load_prompt_template(prompt_path: Path) -> str:
    """Load a prompt template from file."""
    return prompt_path.read_text()


def load_schema(schema_path: Path) -> dict:
    """Load a JSON schema from file."""
    return json.loads(schema_path.read_text())


def extract_pmid_from_filename(json_path: Path) -> int:
    """Extract PMID from filename like '12345678.json'."""
    return int(json_path.stem)


def process_individual_paper(
    variant_id: str,
    docling_json_path: Path,
    variant_details: str,
    prompt_template: str,
    schema: dict,
    client: OpenAI,
    model: str,
) -> dict | None:
    """Process a single paper through individual extraction.

    Checks database for existing extraction to support resumability.
    Stores both raw LLM response and parsed JSON in database.
    """
    pmid = extract_pmid_from_filename(docling_json_path)

    # Check if extraction already exists in database (resumability)
    existing = get_individual_extraction(variant_id, pmid)
    if existing:
        logger.info(f'Skipping {pmid} - extraction already exists in database')
        return existing['extraction_json']

    logger.info(f'Processing paper {pmid}...')

    # Serialize the Docling JSON to text with bbox IDs
    full_text, bbox_mapping = serialize_with_bbox_ids(docling_json_path)

    # Truncate if necessary
    full_text = truncate_paper_text(full_text, pmid)

    # Fill in the prompt template
    prompt = prompt_template.format(
        variant_details=variant_details,
        pmid=pmid,
        full_text=full_text,
    )

    # Call OpenAI with structured output (with retry for invalid citations)
    logger.info(f'Calling LLM for paper {pmid}...')

    max_attempts = 10
    for attempt in range(1, max_attempts + 1):
        response = client.chat.completions.create(
            model=model,
            messages=[{'role': 'user', 'content': prompt}],
            reasoning_effort='high',
            response_format={
                'type': 'json_schema',
                'json_schema': {
                    'name': 'variant_evidence_extraction',
                    'strict': True,
                    'schema': schema,
                },
            },
            max_tokens=20000,
        )

        content = response.choices[0].message.content
        if not content:
            raise ValueError('No content in response')

        # Parse the result
        result = json.loads(content)

        # Validate citations using the same function as aggregate
        is_valid, error_msg = validate_citations(result, {pmid: bbox_mapping})

        if is_valid:
            break

        logger.warning(f'Attempt {attempt}/{max_attempts} - Invalid citations in response: {error_msg}')

        if attempt == max_attempts:
            raise ValueError(f'LLM produced invalid citations after {max_attempts} attempts: {error_msg}')

    # At this point, content and result are guaranteed to be set (we either broke with valid data or raised)
    assert content is not None
    assert result is not None

    # Save to database: raw response, parsed JSON, and bbox mapping
    save_individual_extraction(
        variant_id=variant_id,
        pmid=pmid,
        raw_response=content,
        extraction_json=result,
        bbox_mapping=bbox_mapping,
    )
    logger.info(f'Saved extraction for paper {pmid} to database')

    return result


def validate_citations(result: dict, bbox_mappings: dict[int, dict]) -> tuple[bool, str]:
    """Validate that all citation box_ids exist in bbox_mappings.

    Args:
        result: Aggregate assessment result with citations
        bbox_mappings: Dict mapping {pmid: {box_id: bbox_info}}

    Returns:
        Tuple of (is_valid, error_message)
    """
    citations = result.get('citations', [])
    invalid_citations = []

    for citation in citations:
        pmid = citation.get('pmid')
        box_id = citation.get('box_id')

        if pmid not in bbox_mappings:
            invalid_citations.append(f'PMID {pmid} not found in bbox_mappings (box_id: {box_id})')
        elif box_id not in bbox_mappings[pmid]:
            invalid_citations.append(f'Box ID {box_id} not found in bbox_mapping for PMID {pmid}')

    if invalid_citations:
        error_msg = 'Invalid citations found:\n  ' + '\n  '.join(invalid_citations)
        return False, error_msg

    return True, ''


def aggregate_evidence(
    variant_id: str,
    variant_details: str,
    prompt_template: str,
    schema: dict,
    client: OpenAI,
    model: str,
) -> dict | None:
    """Aggregate evidence from all individual extractions in database."""
    logger.info('Running aggregate assessment...')

    # Initialize PubMed fetcher
    fetcher = PubMedFetcher()

    # Load all individual extractions from database
    extractions = get_all_extractions_for_variant(variant_id)

    if not extractions:
        logger.warning(f'No individual extractions found for {variant_id}')
        return None

    # Build bbox_mappings and evidence_extractions
    evidence_extractions = []
    bbox_mappings = {}

    for extraction in extractions:
        pmid = extraction['pmid']
        extraction_data = extraction['extraction_json']
        bbox_mapping = extraction['bbox_mapping']

        # Store bbox_mapping
        bbox_mappings[pmid] = bbox_mapping

        # Only include papers where variant was discussed
        if extraction_data.get('variant_discussed'):
            # Fetch metadata from PubMed
            logger.info(f'Fetching metadata for PMID {pmid}')
            article = fetcher.article_by_pmid(str(pmid))

            evidence_extractions.append(
                {
                    'pmid': pmid,
                    'title': article.title,
                    'authors': article.authors,
                    'date': article.history['entrez'].date().isoformat(),
                    'evidence': extraction_data['evidence'],
                },
            )

    if not evidence_extractions:
        logger.warning('No papers discussed this variant - cannot aggregate')
        return None

    # Sort by PMID descending (most recent/highest first)
    evidence_extractions.sort(key=lambda x: x['pmid'], reverse=True)

    logger.info(f'Aggregating evidence from {len(evidence_extractions)} papers')

    # Fill in the prompt template
    prompt = prompt_template.format(
        variant_details=variant_details,
        evidence_extractions=json.dumps(evidence_extractions, indent=2),
    )

    # Call OpenAI with structured output (with retry for invalid citations)
    logger.info('Calling LLM for aggregate assessment...')

    max_attempts = 10
    for attempt in range(1, max_attempts + 1):
        response = client.chat.completions.create(
            model=model,
            messages=[{'role': 'user', 'content': prompt}],
            reasoning_effort='high',
            response_format={
                'type': 'json_schema',
                'json_schema': {
                    'name': 'aggregate_variant_assessment',
                    'strict': True,
                    'schema': schema,
                },
            },
            max_tokens=50000,
        )

        choice = response.choices[0]
        logger.info(f'Response finish_reason: {choice.finish_reason}')

        content = choice.message.content
        if not content:
            raise ValueError('No content in response')

        if choice.finish_reason == 'length':
            raise ValueError(f'Response truncated at max_tokens limit. Content length: {len(content)}')

        result = json.loads(content)

        # Validate citations
        is_valid, error_msg = validate_citations(result, bbox_mappings)

        if is_valid:
            break

        logger.warning(f'Attempt {attempt}/{max_attempts} - Invalid citations in response: {error_msg}')

        if attempt == max_attempts:
            raise ValueError(f'LLM produced invalid citations after {max_attempts} attempts: {error_msg}')

    # At this point, content and result are guaranteed to be set (we either broke with valid data or raised)
    assert content is not None
    assert result is not None

    # Save to database: raw response and parsed JSON
    save_aggregate_assessment(
        variant_id=variant_id,
        raw_response=content,
        assessment_json=result,
    )
    logger.info(f'Saved aggregate assessment for {variant_id} to database')

    # Pretty-print the result to stdout
    console.print('\n')
    console.print(Panel('[bold]Aggregate Assessment Results[/bold]', style='blue'))
    console.print(f'\n[bold cyan]Classification:[/bold cyan] {result["classification"]}')
    console.print('\n[bold cyan]Classification Rationale:[/bold cyan]')
    console.print(result['classification_rationale'])
    console.print('\n[bold cyan]Description:[/bold cyan]')
    console.print(result['description'])
    console.print('\n[bold cyan]Notes:[/bold cyan]')
    console.print(Markdown(result['notes']))
    console.print(f'\n[bold cyan]Citations:[/bold cyan] {len(result["citations"])} items')
    console.print()

    return result


def query_mutalyzer(hgvs_c: str) -> dict:
    """
    Query VariantValidator API for variant details.

    Args:
        hgvs_c: HGVS c. notation (e.g., "NM_000152.5:c.2238G>C")

    Returns:
        Complete JSON response from VariantValidator API
    """
    base_url = 'https://rest.variantvalidator.org/VariantValidator/variantvalidator'
    url = f'{base_url}/GRCh38/{hgvs_c}/mane_select'

    logger.info(f'Querying Mutalyzer for {hgvs_c}')

    with httpx.Client() as client:
        response = client.get(
            url,
            params={'content-type': 'application/json'},
            headers={'accept': 'application/json'},
        )
        response.raise_for_status()
        return response.json()


def process_variant(
    variant_id: str = typer.Option(..., '--id', help='Variant identifier'),
) -> None:
    """Process variant literature through extraction and aggregation.

    Reads variant from database, queries VariantValidator for variant details,
    processes papers from data/papers/, and stores results in database.
    Supports resumability by checking database before doing LLM work.
    """
    # Load settings
    settings = Settings()
    if not settings.openai_api_key:
        typer.echo('Error: OPENAI_API_KEY environment variable not set', err=True)
        raise typer.Exit(1)

    # Get variant from database
    variant = get_variant(variant_id)
    if not variant:
        typer.echo(f'Error: Variant not found: {variant_id}', err=True)
        raise typer.Exit(1)

    # Check if aggregate assessment already exists (resumability)
    existing_aggregate = get_aggregate_assessment(variant_id)
    if existing_aggregate:
        logger.info(f'Aggregate assessment already exists for {variant_id} - skipping')
        return

    # Parse PMIDs
    pmids_json = variant.get('pmids')
    if not pmids_json:
        logger.error(f'No PMIDs found for variant {variant_id}')
        raise typer.Exit(1)

    pmids = json.loads(pmids_json)
    if not pmids:
        logger.error(f'Empty PMID list for variant {variant_id}')
        raise typer.Exit(1)

    # Query VariantValidator for variant details
    hgvs_c = variant['hgvs_c']
    logger.info(f'Querying VariantValidator for {hgvs_c}')
    try:
        mutalyzer_response = query_mutalyzer(hgvs_c)
        variant_details = json.dumps(mutalyzer_response, indent=2)
    except Exception as e:
        logger.error(f'Failed to query VariantValidator: {e}')
        raise typer.Exit(1) from e

    # Load prompts and schemas
    prompts_dir = Path('prompts')
    individual_prompt = load_prompt_template(prompts_dir / 'individual_extraction_prompt.txt')
    individual_schema = load_schema(prompts_dir / 'individual_extraction_schema.json')
    aggregate_prompt = load_prompt_template(prompts_dir / 'aggregate_assessment_prompt.txt')
    aggregate_schema = load_schema(prompts_dir / 'aggregate_assessment_schema.json')

    # Initialize OpenAI client
    client = OpenAI(api_key=settings.openai_api_key, base_url=settings.openai_base_url)

    # Find paper JSON files for this variant's PMIDs
    papers_dir = Path('data/papers')
    docling_files = []
    for pmid in pmids:
        docling_file = papers_dir / f'{pmid}.json'
        if docling_file.exists():
            docling_files.append(docling_file)
        else:
            logger.warning(f'Docling JSON not found for PMID {pmid}: {docling_file}')

    if not docling_files:
        logger.error(f'No Docling JSON files found for variant {variant_id}')
        raise typer.Exit(1)

    logger.info(f'Found {len(docling_files)} papers to process')

    # Process individual papers with progress
    with Progress(
        SpinnerColumn(),
        TextColumn('[progress.description]{task.description}'),
        BarColumn(),
        TaskProgressColumn(),
        console=console,
    ) as progress:
        papers_task = progress.add_task(
            f'[green]Processing papers for {variant_id}...',
            total=len(docling_files),
        )

        for docling_file in docling_files:
            pmid = extract_pmid_from_filename(docling_file)

            progress.update(papers_task, description=f'[green]Paper PMID: {pmid}')

            process_individual_paper(
                variant_id=variant_id,
                docling_json_path=docling_file,
                variant_details=variant_details,
                prompt_template=individual_prompt,
                schema=individual_schema,
                client=client,
                model=settings.openai_model,
            )

            progress.advance(papers_task)

    # Run aggregate assessment
    aggregate_result = aggregate_evidence(
        variant_id=variant_id,
        variant_details=variant_details,
        prompt_template=aggregate_prompt,
        schema=aggregate_schema,
        client=client,
        model=settings.openai_model,
    )

    if aggregate_result:
        logger.info(f'✓ Variant {variant_id} processed successfully')
    else:
        logger.info(f'No aggregate result for {variant_id} (no papers discussed variant)')

    logger.info(f'\n✓ Processing complete for {variant_id}')
