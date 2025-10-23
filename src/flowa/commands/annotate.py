"""Create annotated PDFs from variant assessment citations with highlighting."""

import logging
from pathlib import Path
from typing import Any

import typer
from pypdf import PdfReader, PdfWriter
from pypdf.annotations import Highlight
from pypdf.generic import (
    ArrayObject,
    FloatObject,
    NameObject,
    TextStringObject,
)

from flowa.db import get_aggregate_assessment, get_all_extractions_for_variant, get_variant

logger = logging.getLogger(__name__)


def load_aggregate_citations(variant_id: str) -> list[dict[str, Any]]:
    """Load citations from aggregate assessment for a variant from database.

    Args:
        variant_id: Variant identifier

    Returns:
        List of citation dicts with pmid, box_id, and commentary
    """
    db_path = Path('data') / 'db.sqlite'
    aggregate = get_aggregate_assessment(variant_id, db_path=db_path)

    if not aggregate:
        logger.warning(f'Aggregate assessment not found in database for variant: {variant_id}')
        return []

    aggregate_data = aggregate['assessment_json']
    return aggregate_data.get('citations', [])


def load_bbox_mappings(variant_id: str) -> dict[int, dict[int, dict[str, Any]]]:
    """Load bbox mappings from database for a variant.

    Args:
        variant_id: Variant identifier

    Returns:
        Dict mapping {pmid: {box_id: {"page": N, "bbox": {...}}}}
    """
    db_path = Path('data') / 'db.sqlite'
    extractions = get_all_extractions_for_variant(variant_id, db_path=db_path)

    if not extractions:
        logger.warning(f'No extractions found in database for variant: {variant_id}')
        return {}

    bbox_mappings = {}
    for extraction in extractions:
        pmid = extraction['pmid']
        bbox_mapping = extraction['bbox_mapping']
        bbox_mappings[pmid] = bbox_mapping

    return bbox_mappings


def organize_citations_by_pmid(
    citations: list[dict[str, Any]],
    bbox_mappings: dict[int, dict[int, dict]],
) -> dict[int, list[dict[str, Any]]]:
    """Organize citations by PMID and enrich with page numbers.

    Args:
        citations: List of citations from aggregate.json
        bbox_mappings: Dict mapping {pmid: {box_id: bbox_info}}

    Returns:
        Dict mapping {pmid: [citation_with_page, ...]}
    """
    citations_by_pmid: dict[int, list[dict]] = {}

    for citation in citations:
        pmid = citation['pmid']
        box_id = citation['box_id']
        commentary = citation.get('commentary', '')

        # Check if bbox mapping exists
        if pmid not in bbox_mappings:
            logger.warning(f'PMID {pmid} not found in bbox mappings')
            continue

        if box_id not in bbox_mappings[pmid]:
            logger.warning(f'Box ID {box_id} not found in bbox mapping for PMID {pmid}')
            continue

        bbox_info = bbox_mappings[pmid][box_id]
        page = bbox_info['page']

        if pmid not in citations_by_pmid:
            citations_by_pmid[pmid] = []

        citations_by_pmid[pmid].append(
            {
                'box_id': box_id,
                'commentary': commentary,
                'page': page,
            },
        )

    return citations_by_pmid


def create_pdf_annotations(
    pdf_path: Path,
    citations: list[dict[str, Any]],
    bbox_mapping: dict[int, dict[str, Any]],
    output_path: Path,
    variant_label: str,
) -> bool:
    """Create annotated PDF with highlight annotations for citations.

    Args:
        pdf_path: Path to original PDF
        citations: List of citation dicts with box_id, commentary, and page
        bbox_mapping: Mapping from box_id to bbox info for this PMID
        output_path: Path for annotated PDF output
        variant_label: Label for the variant (e.g., "case123/var456")

    Returns:
        True if successful, False otherwise
    """
    try:
        reader = PdfReader(pdf_path)
        writer = PdfWriter()

        # Process each page
        for page_num, page in enumerate(reader.pages, 1):
            writer.add_page(page)

            # Find citations for this page
            page_citations = [c for c in citations if c.get('page') == page_num]

            # Add annotations for this page
            for citation in page_citations:
                box_id = citation['box_id']

                if box_id not in bbox_mapping:
                    logger.warning(f'Box ID {box_id} not found in bbox mapping for page {page_num}')
                    continue

                bbox_info = bbox_mapping[box_id]
                bbox = bbox_info['bbox']

                # Use bbox coordinates directly (BOTTOMLEFT origin)
                x1, y1, x2, y2 = bbox['l'], bbox['b'], bbox['r'], bbox['t']

                # Create highlight annotation with quad_points for the rectangle
                quad_points = ArrayObject(
                    [
                        FloatObject(x1),
                        FloatObject(y2),  # Top-left
                        FloatObject(x2),
                        FloatObject(y2),  # Top-right
                        FloatObject(x1),
                        FloatObject(y1),  # Bottom-left
                        FloatObject(x2),
                        FloatObject(y1),  # Bottom-right
                    ],
                )

                highlight_annotation = Highlight(
                    rect=(x1, y1, x2, y2),
                    quad_points=quad_points,
                    highlight_color='ffeb3b',  # Light yellow highlighter color
                )

                # Add commentary as content/note using proper pypdf objects
                content = citation['commentary']
                highlight_annotation.update(
                    {
                        NameObject('/Contents'): TextStringObject(content),
                        NameObject('/T'): TextStringObject(f'{variant_label} - Variant Evidence'),
                        NameObject('/NM'): TextStringObject(f'citation_{box_id}'),
                    },
                )

                # Add annotation to the page
                writer.add_annotation(page_number=page_num - 1, annotation=highlight_annotation)

        # Write annotated PDF
        with open(output_path, 'wb') as output_file:
            writer.write(output_file)

        logger.info(f'Created annotated PDF with {len(citations)} highlights: {output_path}')
        return True

    except (OSError, ValueError) as e:
        logger.error(f'Failed to create annotated PDF for {pdf_path}: {e}')
        return False


def annotate_pdfs(
    variant_id: str = typer.Option(..., '--id', help='Variant identifier'),
) -> None:
    """Create annotated PDFs from variant assessment with citation highlighting.

    Loads citations and bbox mappings from database, and creates annotated PDFs
    with yellow highlights at citation locations.

    Saves to reports/{variant_id}/annotated/{pmid}.pdf
    """
    # Get variant from database
    variant = get_variant(variant_id)
    if not variant:
        typer.echo(f'Error: Variant not found: {variant_id}', err=True)
        raise typer.Exit(1)

    logger.info(f'Processing variant: {variant_id}')

    # Load citations and bbox mappings
    citations = load_aggregate_citations(variant_id)
    if not citations:
        logger.info(f'No citations found for {variant_id}')
        return

    bbox_mappings = load_bbox_mappings(variant_id)
    if not bbox_mappings:
        logger.warning(f'No bbox mappings found for {variant_id}')
        return

    # Organize citations by PMID
    citations_by_pmid = organize_citations_by_pmid(citations, bbox_mappings)

    if not citations_by_pmid:
        logger.warning(f'No valid citations with bbox mappings for {variant_id}')
        return

    # Create output directory for this variant
    output_dir = Path('reports') / variant_id / 'annotated'
    output_dir.mkdir(parents=True, exist_ok=True)

    # Papers directory (shared cache)
    papers_dir = Path('data/papers')

    # Process each PMID
    successful = 0
    failed = 0
    skipped = 0

    for pmid, pmid_citations in citations_by_pmid.items():
        output_path = output_dir / f'{pmid}.pdf'

        # Skip if already exists
        if output_path.exists():
            logger.debug(f'Already exists: {output_path}')
            skipped += 1
            continue

        # Find original PDF in shared cache
        pdf_path = papers_dir / f'{pmid}.pdf'
        if not pdf_path.exists():
            logger.warning(f'Original PDF not found: {pdf_path}')
            failed += 1
            continue

        logger.info(f'Creating {len(pmid_citations)} annotations for PMID {pmid}')

        # Create annotated PDF
        success = create_pdf_annotations(
            pdf_path=pdf_path,
            citations=pmid_citations,
            bbox_mapping=bbox_mappings[pmid],
            output_path=output_path,
            variant_label=variant_id,
        )

        if success:
            successful += 1
        else:
            failed += 1

    logger.info('\n' + '=' * 60)
    logger.info(f'Successfully annotated: {successful} PDFs')
    logger.info(f'Skipped (already exist): {skipped} PDFs')
    logger.info(f'Failed: {failed} PDFs')
    logger.info(f'Annotated PDFs saved to: {output_dir}')
    logger.info('=' * 60)
