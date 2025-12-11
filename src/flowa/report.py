"""Generate HTML report for variant literature assessment."""

import logging
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import typer
from jinja2 import Environment, FileSystemLoader, select_autoescape
from markdown import markdown
from markupsafe import Markup
from pydantic_settings import BaseSettings, SettingsConfigDict

from flowa.docling import load_bbox_mapping
from flowa.storage import assessment_url, read_json, write_text

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


def enrich_citations_with_pages(
    citations: list[dict[str, Any]],
    bbox_mappings: dict[int, dict[int, dict[str, Any]]],
) -> list[dict[str, Any]]:
    """Enrich citations with page numbers from bbox mappings.

    Raises:
        ValueError: If any citation is missing bbox mapping (fail fast).
    """
    enriched: list[dict[str, Any]] = []
    for citation in citations:
        pmid = citation['pmid']
        box_id = citation['box_id']
        commentary = citation.get('commentary', '')

        mapping = bbox_mappings.get(pmid, {})
        bbox_info = mapping.get(box_id)
        if not bbox_info:
            raise ValueError(f'Missing bbox for citation pmid={pmid} box_id={box_id}')

        enriched.append(
            {
                'pmid': pmid,
                'box_id': box_id,
                'commentary': commentary,
                'page': bbox_info['page'],
            }
        )

    return enriched


def generate_report(
    *,
    variant_id: str = typer.Option(..., '--variant-id', help='Variant ID'),
    output: str = typer.Option(..., '--output', help='Output HTML file path (fsspec URI)'),
) -> None:
    """Generate HTML report for variant assessment.

    Reads query.json and aggregate.json from storage, generates a single-column
    HTML report with classification, evidence, and citations.

    Example:
        flowa report --variant-id GAA_variant --output s3://bucket/reports/report.html
    """
    logger.info('Generating report for variant: %s', variant_id)

    # Load settings
    settings = Settings()
    tz = ZoneInfo(settings.timezone)

    # Load query data (gene, hgvs_c, pmids)
    query_url = assessment_url(variant_id, 'query.json')
    logger.info('Loading query data from %s', query_url)
    try:
        query_data = read_json(query_url)
    except FileNotFoundError:
        logger.error('query.json not found at %s', query_url)
        raise typer.Exit(code=1) from None

    gene = query_data['gene']
    hgvs_c = query_data['hgvs_c']
    pmids = query_data['pmids']

    # Load aggregate data
    aggregate_url = assessment_url(variant_id, 'aggregate.json')
    logger.info('Loading aggregate assessment from %s', aggregate_url)
    try:
        aggregate_data = read_json(aggregate_url)
    except FileNotFoundError:
        logger.error('aggregate.json not found at %s', aggregate_url)
        logger.error('Have you run `flowa aggregate --variant-id %s` yet?', variant_id)
        raise typer.Exit(code=1) from None

    classification = aggregate_data['classification']
    classification_rationale = aggregate_data['classification_rationale']
    description = aggregate_data['description']
    notes = aggregate_data['notes']
    citations = aggregate_data['citations']

    # Load bbox mappings for cited PMIDs only
    logger.info('Loading bbox mappings for %d citations...', len(citations))
    cited_pmids = {c['pmid'] for c in citations}
    bbox_mappings: dict[int, dict[int, dict[str, Any]]] = {}
    for pmid in cited_pmids:
        try:
            bbox_mappings[pmid] = load_bbox_mapping(pmid)
        except FileNotFoundError:
            logger.error('docling.json not found for cited PMID %s', pmid)
            raise typer.Exit(code=1) from None

    # Enrich citations with page numbers (fails fast if any bbox missing)
    try:
        citations = enrich_citations_with_pages(citations, bbox_mappings)
    except ValueError as e:
        logger.error(str(e))
        raise typer.Exit(code=1) from None

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
    templates_dir = Path(__file__).parent.parent.parent / 'templates'
    css_path = templates_dir / 'report.css'

    logger.info('Loading CSS from: %s', css_path)
    css_content = Markup(css_path.read_text())

    logger.info('Loading template from: %s', templates_dir)
    env = Environment(
        loader=FileSystemLoader(templates_dir),
        autoescape=select_autoescape(['html', 'xml']),
    )
    template = env.get_template('report.html')

    # Render template
    logger.info('Rendering HTML...')
    html_output = template.render(css=css_content, **template_data)

    # Write output
    logger.info('Writing output to: %s', output)
    write_text(output, html_output)

    logger.info('=' * 60)
    logger.info('Report Generation Complete!')
    logger.info('=' * 60)
    logger.info('Variant: %s', variant_id)
    logger.info('Classification: %s', classification)
    logger.info('Articles reviewed: %d', len(pmids))
    logger.info('Citations: %d', len(citations))
    logger.info('Output: %s', output)
    logger.info('=' * 60)
