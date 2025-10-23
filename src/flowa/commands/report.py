"""Generate HTML report for variant literature assessment."""

import json
import logging
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import typer
from jinja2 import Environment, FileSystemLoader, select_autoescape
from markdown import markdown
from markupsafe import Markup
from pydantic_settings import BaseSettings, SettingsConfigDict

from flowa.db import get_aggregate_assessment, get_all_extractions_for_variant, get_variant

logger = logging.getLogger(__name__)


class Settings(BaseSettings):
    """Environment configuration."""

    model_config = SettingsConfigDict(env_file='.env', env_file_encoding='utf-8', extra='ignore')

    timezone: str = 'Australia/Sydney'


def render_markdown_to_html(md_text: str | None) -> str:
    """Convert markdown text to HTML."""
    if not md_text:
        return ''
    return markdown(
        md_text,
        extensions=[
            'fenced_code',
            'tables',
            'nl2br',
        ],
    )


def load_aggregate_data(variant_id: str) -> dict:
    """Load aggregate assessment data for a variant from database.

    Args:
        variant_id: The variant identifier

    Returns:
        Dict containing aggregate assessment data

    Raises:
        ValueError: If aggregate assessment doesn't exist in database
    """
    db_path = Path('data') / 'db.sqlite'
    aggregate = get_aggregate_assessment(variant_id, db_path=db_path)

    if not aggregate:
        msg = f'Aggregate assessment not found in database for variant: {variant_id}'
        raise ValueError(msg)

    return aggregate['assessment_json']


def load_bbox_mappings(variant_id: str) -> dict[int, dict[int, dict]]:
    """Load bbox mappings from database for a variant.

    Args:
        variant_id: The variant identifier

    Returns:
        Dict mapping {pmid: {box_id: {"page": N, "bbox": {...}}}}
    """
    db_path = Path('data') / 'db.sqlite'
    extractions = get_all_extractions_for_variant(variant_id, db_path=db_path)

    bbox_mappings = {}
    for extraction in extractions:
        pmid = extraction['pmid']
        bbox_mapping = extraction['bbox_mapping']
        bbox_mappings[pmid] = bbox_mapping

    return bbox_mappings


def enrich_citations_with_pages(citations: list[dict], bbox_mappings: dict[int, dict[int, dict]]) -> list[dict]:
    """Enrich citations with page numbers from bbox mappings.

    Args:
        citations: List of {"pmid": X, "box_id": Y, "commentary": "..."}
        bbox_mappings: Dict mapping {pmid: {box_id: {"page": N}}}

    Returns:
        Enriched citations with page numbers added
    """
    enriched = []
    for citation in citations:
        pmid = citation['pmid']
        box_id = citation['box_id']
        commentary = citation.get('commentary', '')

        # Get page number from bbox mapping
        page = bbox_mappings[pmid][box_id]['page']

        enriched.append(
            {
                'pmid': pmid,
                'box_id': box_id,
                'commentary': commentary,
                'page': page,
            }
        )

    return enriched


def generate_report(
    *,
    variant_id: str = typer.Option(..., '--id', help='Variant ID'),
    output: Path = typer.Option(..., '--output', help='Output HTML file path'),
) -> None:
    """Generate HTML report for variant assessment.

    Reads variant from database, loads aggregate assessment, and generates
    a single-column HTML report with classification, evidence, and citations.

    Example:
        flowa report --id GAA_variant --output reports/GAA_variant.html
    """
    logger.info(f'Generating report for variant: {variant_id}')

    # Load settings
    settings = Settings()
    tz = ZoneInfo(settings.timezone)

    # Load variant from database
    logger.info('Loading variant from database...')
    db_path = Path('data') / 'db.sqlite'
    variant = get_variant(variant_id, db_path=db_path)

    if not variant:
        logger.error(f'Variant not found in database: {variant_id}')
        raise typer.Exit(code=1)

    # Load aggregate data
    logger.info('Loading aggregate assessment...')
    try:
        aggregate_data = load_aggregate_data(variant_id)
    except ValueError as e:
        logger.error(str(e))
        logger.error(f'Have you run `flowa process --id {variant_id}` yet?')
        raise typer.Exit(code=1) from e

    # Extract data for template
    gene = variant['gene']
    hgvs_c = variant['hgvs_c']
    pmids = json.loads(variant['pmids']) if variant.get('pmids') else []

    classification = aggregate_data['classification']
    classification_rationale = aggregate_data['classification_rationale']
    description = aggregate_data['description']
    notes = aggregate_data['notes']
    citations = aggregate_data['citations']

    # Load bbox mappings and enrich citations with page numbers
    logger.info('Loading bbox mappings...')
    bbox_mappings = load_bbox_mappings(variant_id)
    citations = enrich_citations_with_pages(citations, bbox_mappings)

    # Render markdown notes to HTML
    notes_html = Markup(render_markdown_to_html(notes))

    # Prepare template data
    template_data = {
        'variant_name': variant_id,
        'gene': gene,
        'hgvs_c': hgvs_c,
        'pmids': pmids,
        'classification': classification,
        'classification_rationale': classification_rationale,
        'description': description,
        'notes_html': notes_html,
        'citations': citations,
        'generation_date': datetime.now(tz).strftime('%Y-%m-%d %H:%M:%S'),
    }

    # Load template and CSS
    # Templates are in the package's templates/ directory
    templates_dir = Path(__file__).parent.parent.parent.parent / 'templates'
    css_path = templates_dir / 'report.css'

    logger.info(f'Loading CSS from: {css_path}')
    css_content = Markup(css_path.read_text())

    logger.info(f'Loading template from: {templates_dir}')
    env = Environment(
        loader=FileSystemLoader(templates_dir),
        autoescape=select_autoescape(['html', 'xml']),
    )
    template = env.get_template('report.html')

    # Render template
    logger.info('Rendering HTML...')
    html_output = template.render(css=css_content, **template_data)

    # Write output
    logger.info(f'Writing output to: {output}')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(html_output)

    logger.info('=' * 60)
    logger.info('Report Generation Complete!')
    logger.info('=' * 60)
    logger.info(f'Variant: {variant_id}')
    logger.info(f'Classification: {classification}')
    logger.info(f'Articles reviewed: {len(pmids)}')
    logger.info(f'Citations: {len(citations)}')
    logger.info(f'Output: {output}')
    logger.info('=' * 60)
