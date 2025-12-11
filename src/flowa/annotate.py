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
from flowa.storage import assessment_url, exists, paper_url, read_bytes, read_json, write_bytes

log = logging.getLogger(__name__)


def load_aggregate_citations(variant_id: str) -> list[dict[str, Any]]:
    """Load citations from assessments/{variant_id}/aggregate.json."""
    aggregate_data = read_json(assessment_url(variant_id, 'aggregate.json'))
    citations: list[dict[str, Any]] = aggregate_data.get('citations', [])
    if not citations:
        log.info('No citations found in aggregate for %s', variant_id)
    return citations


def organize_citations_by_pmid(
    citations: list[dict[str, Any]],
    bbox_mappings: dict[int, dict[int, dict[str, Any]]],
) -> dict[int, list[dict[str, Any]]]:
    """Group citations by PMID and attach page/bbox info from mappings."""
    citations_by_pmid: dict[int, list[dict[str, Any]]] = defaultdict(list)

    for citation in citations:
        pmid = citation['pmid']
        box_id = citation['box_id']
        commentary = citation.get('commentary', '')

        if pmid not in bbox_mappings:
            log.warning('Skipping citation: PMID %s missing bbox mapping', pmid)
            continue

        bbox_mapping = bbox_mappings[pmid]
        if box_id not in bbox_mapping:
            log.warning('Skipping citation: PMID %s box_id %s not found', pmid, box_id)
            continue

        bbox_info = bbox_mapping[box_id]
        citations_by_pmid[pmid].append(
            {
                'box_id': box_id,
                'commentary': commentary,
                'page': bbox_info['page'],
                'bbox': bbox_info['bbox'],
                'coord_origin': bbox_info.get('coord_origin'),
            },
        )

    return citations_by_pmid


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
                log.warning('Box ID %s not found for PMID page %s', box_id, page_num)
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

            content = citation['commentary']
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

    pmids = {c['pmid'] for c in citations}
    bbox_mappings: dict[int, dict[int, dict[str, Any]]] = {}

    for pmid in pmids:
        try:
            bbox_mappings[pmid] = load_bbox_mapping(pmid)
        except FileNotFoundError:
            log.warning('docling.json not found for PMID %s - skipping annotations for this paper', pmid)
        except Exception as exc:
            log.error('Failed to load bbox mapping for PMID %s: %s', pmid, exc)

    if not bbox_mappings:
        log.warning('No bbox mappings available - nothing to annotate')
        return

    citations_by_pmid = organize_citations_by_pmid(citations, bbox_mappings)
    if not citations_by_pmid:
        log.warning('No valid citations after bbox lookup - nothing to annotate')
        return

    successful = 0
    failed = 0

    for pmid, pmid_citations in citations_by_pmid.items():
        pdf_url = paper_url(pmid, 'source.pdf')
        output_url = assessment_url(variant_id, 'annotated', f'{pmid}.pdf')

        if not exists(pdf_url):
            log.warning('Original PDF missing for PMID %s at %s', pmid, pdf_url)
            failed += 1
            continue

        log.info('Creating %d annotations for PMID %s', len(pmid_citations), pmid)
        success = create_pdf_annotations(
            pdf_url=pdf_url,
            output_url=output_url,
            citations=pmid_citations,
            bbox_mapping=bbox_mappings[pmid],
            variant_label=variant_id,
        )

        if success:
            successful += 1
        else:
            failed += 1

    log.info('Annotated PDFs created: %d | failed: %d', successful, failed)
