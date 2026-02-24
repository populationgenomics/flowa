"""Create annotated PDFs from aggregate citations stored in object storage."""

import logging
from collections import defaultdict
from io import BytesIO
from typing import Any

import typer
from pypdf import PdfReader, PdfWriter
from pypdf.annotations import Highlight
from pypdf.generic import ArrayObject, FloatObject, NameObject, TextStringObject

from flowa.docling import load_bbox_mapping
from flowa.storage import assessment_url, encode_doi, exists, paper_url, read_bytes, read_json, write_bytes

log = logging.getLogger(__name__)


def load_aggregate_citations(variant_id: str) -> list[dict[str, Any]]:
    """Load citations from assessments/{variant_id}/aggregate.json.

    Collects citations from all categories in results map, embedding the category
    in each citation for annotation purposes.
    """
    aggregate_data = read_json(assessment_url(variant_id, 'aggregate.json'))
    results = aggregate_data.get('results', {})
    citations: list[dict[str, Any]] = []
    for category, cat_result in results.items():
        for citation in cat_result.get('citations', []):
            citations.append({**citation, 'category': category})
    if not citations:
        log.info('No citations found in aggregate for %s', variant_id)
    return citations


def organize_citations_by_doi(
    citations: list[dict[str, Any]],
    bbox_mappings: dict[str, dict[int, dict[str, Any]]],
) -> dict[str, list[dict[str, Any]]]:
    """Group citations by DOI and attach page/bbox info from mappings."""
    citations_by_doi: dict[str, list[dict[str, Any]]] = defaultdict(list)

    for citation in citations:
        doi = citation['doi']
        box_id = citation['box_id']
        commentary = citation.get('commentary', '')

        if doi not in bbox_mappings:
            log.warning('Skipping citation: %s missing bbox mapping', doi)
            continue

        bbox_mapping = bbox_mappings[doi]
        if box_id not in bbox_mapping:
            log.warning('Skipping citation: %s box_id %s not found', doi, box_id)
            continue

        bbox_info = bbox_mapping[box_id]
        citations_by_doi[doi].append(
            {
                'box_id': box_id,
                'commentary': commentary,
                'category': citation.get('category', ''),
                'page': bbox_info['page'],
                'bbox': bbox_info['bbox'],
                'coord_origin': bbox_info.get('coord_origin'),
            },
        )

    return citations_by_doi


def _to_pdf_coordinates(
    bbox: dict[str, Any],
    page_height: float,
    coord_origin: str | None,
) -> tuple[float, float, float, float]:
    """Convert bbox coordinates to PDF bottom-left origin if needed."""
    x1, x2 = float(bbox['l']), float(bbox['r'])
    y_top_raw, y_bottom_raw = float(bbox['t']), float(bbox['b'])

    if coord_origin and coord_origin.upper().startswith('TOP'):
        y_top = page_height - y_top_raw
        y_bottom = page_height - y_bottom_raw
    else:
        y_top, y_bottom = y_top_raw, y_bottom_raw

    y1, y2 = sorted([y_bottom, y_top])
    return x1, y1, x2, y2


def create_pdf_annotations(
    pdf_url: str,
    output_url: str,
    citations: list[dict[str, Any]],
    bbox_mapping: dict[int, dict[str, Any]],
    variant_label: str,
) -> bool:
    """Create annotated PDF with highlight annotations and write to storage."""
    try:
        pdf_bytes = read_bytes(pdf_url)
    except FileNotFoundError:
        log.warning('Original PDF not found: %s', pdf_url)
        return False

    try:
        reader = PdfReader(BytesIO(pdf_bytes))
    except Exception as exc:  # pypdf can raise various parsing errors
        log.error('Failed to read PDF %s: %s', pdf_url, exc)
        return False

    writer = PdfWriter()

    for page_num, page in enumerate(reader.pages, 1):
        writer.add_page(page)
        page_height = float(page.mediabox.height)

        page_citations = [c for c in citations if c.get('page') == page_num]
        if not page_citations:
            continue

        for citation in page_citations:
            box_id = citation['box_id']

            if box_id not in bbox_mapping:
                log.warning('Box ID %s not found on page %s', box_id, page_num)
                continue

            x1, y1, x2, y2 = _to_pdf_coordinates(
                bbox=citation['bbox'],
                page_height=page_height,
                coord_origin=citation.get('coord_origin') or bbox_mapping[box_id].get('coord_origin'),
            )

            quad_points = ArrayObject(
                [
                    FloatObject(x1),
                    FloatObject(y2),
                    FloatObject(x2),
                    FloatObject(y2),
                    FloatObject(x1),
                    FloatObject(y1),
                    FloatObject(x2),
                    FloatObject(y1),
                ],
            )

            highlight_annotation = Highlight(
                rect=(x1, y1, x2, y2),
                quad_points=quad_points,
                highlight_color='ffeb3b',
            )

            category = citation.get('category', '')
            commentary = citation['commentary']
            content = f'[{category}] {commentary}' if category else commentary
            highlight_annotation.update(
                {
                    NameObject('/Contents'): TextStringObject(content),
                    NameObject('/T'): TextStringObject(f'{variant_label} - Variant Evidence'),
                    NameObject('/NM'): TextStringObject(f'citation_{box_id}'),
                },
            )

            writer.add_annotation(page_number=page_num - 1, annotation=highlight_annotation)

    try:
        output_buffer = BytesIO()
        writer.write(output_buffer)
        write_bytes(output_url, output_buffer.getvalue())
    except Exception as exc:
        log.error('Failed to write annotated PDF %s: %s', output_url, exc)
        return False

    log.info('Created annotated PDF with %d highlights: %s', len(citations), output_url)
    return True


def annotate_pdfs(
    variant_id: str = typer.Option(..., '--variant-id', help='Variant identifier'),
) -> None:
    """Create annotated PDFs from aggregate citations stored in object storage."""
    log.info('Annotating PDFs for variant %s', variant_id)

    try:
        citations = load_aggregate_citations(variant_id)
    except FileNotFoundError:
        log.error('aggregate.json not found for variant %s', variant_id)
        raise typer.Exit(1) from None

    if not citations:
        return

    dois = {c['doi'] for c in citations}
    bbox_mappings: dict[str, dict[int, dict[str, Any]]] = {}

    for doi in dois:
        try:
            bbox_mappings[doi] = load_bbox_mapping(doi)
        except FileNotFoundError:
            log.warning('docling.json not found for %s - skipping annotations for this paper', doi)
        except Exception as exc:
            log.error('Failed to load bbox mapping for %s: %s', doi, exc)

    if not bbox_mappings:
        log.warning('No bbox mappings available - nothing to annotate')
        return

    citations_by_doi = organize_citations_by_doi(citations, bbox_mappings)
    if not citations_by_doi:
        log.warning('No valid citations after bbox lookup - nothing to annotate')
        return

    successful = 0
    failed = 0

    for doi, doi_citations in citations_by_doi.items():
        pdf_url = paper_url(doi, 'source.pdf')
        output_url = assessment_url(variant_id, 'annotated', f'{encode_doi(doi)}.pdf')

        if not exists(pdf_url):
            log.warning('Original PDF missing for %s at %s', doi, pdf_url)
            failed += 1
            continue

        log.info('Creating %d annotations for %s', len(doi_citations), doi)
        success = create_pdf_annotations(
            pdf_url=pdf_url,
            output_url=output_url,
            citations=doi_citations,
            bbox_mapping=bbox_mappings[doi],
            variant_label=variant_id,
        )

        if success:
            successful += 1
        else:
            failed += 1

    log.info('Annotated PDFs created: %d | failed: %d', successful, failed)
