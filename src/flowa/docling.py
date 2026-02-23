"""Docling document serialization with bbox tracking."""

import re
from typing import Any, cast

from docling_core.transforms.serializer.base import BaseDocSerializer, SerializationResult
from docling_core.transforms.serializer.common import create_ser_result
from docling_core.transforms.serializer.markdown import (
    MarkdownDocSerializer,
    MarkdownPictureSerializer,
    MarkdownTableSerializer,
    MarkdownTextSerializer,
)
from docling_core.types.doc import DoclingDocument, PictureItem, TableItem, TextItem
from pydantic import Field

from flowa.storage import paper_url, read_json


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
        wrapped = cast(BboxMarkdownDocSerializer, doc_serializer).wrap_with_bbox(item, result.text)
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
        wrapped = cast(BboxMarkdownDocSerializer, doc_serializer).wrap_with_bbox(item, result.text)
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
        wrapped = cast(BboxMarkdownDocSerializer, doc_serializer).wrap_with_bbox(item, result.text)
        return create_ser_result(text=wrapped, span_source=[result])


class BboxMarkdownDocSerializer(MarkdownDocSerializer):
    """Document serializer that tracks bbox mappings and wraps items with IDs."""

    text_serializer: BboxMarkdownTextSerializer = BboxMarkdownTextSerializer()
    table_serializer: BboxMarkdownTableSerializer = BboxMarkdownTableSerializer()
    picture_serializer: BboxMarkdownPictureSerializer = BboxMarkdownPictureSerializer()

    box_id_counter: int = 1
    bbox_mapping: dict[int, dict[str, Any]] = Field(default_factory=dict)

    def wrap_with_bbox(self, item: Any, text: str) -> str:
        """Wrap text with bbox ID if item has provenance information.

        Returns:
            Text wrapped with <b id=N>...</b> tags if bbox available and content is meaningful,
            empty string if content is placeholder-only, otherwise unchanged
        """
        if not text:
            return text

        # Skip placeholder-only content (e.g., "<!-- image -->")
        text_without_comments = re.sub(r'<!--.*?-->', '', text, flags=re.DOTALL)
        if not text_without_comments.strip():
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


def serialize_with_bbox_ids(docling_json: dict) -> tuple[str, dict[int, dict[str, Any]]]:
    """Serialize Docling JSON document to markdown with bbox IDs.

    Args:
        docling_json: Docling document as dict (parsed JSON)

    Returns:
        Tuple of (serialized_text, bbox_mapping_dict)

    The bbox_mapping_dict maps box_id to:
    {
        "page": page_number,
        "bbox": {"l": left, "t": top, "r": right, "b": bottom}
    }
    """
    doc = DoclingDocument.model_validate(docling_json)
    serializer = BboxMarkdownDocSerializer(doc=doc)
    result = serializer.serialize()

    return result.text, serializer.bbox_mapping


def load_bbox_mapping(doi: str) -> dict[int, dict[str, Any]]:
    """Load and compute bbox mapping from papers/{doi}/docling.json."""
    docling_json = read_json(paper_url(doi, 'docling.json'))
    _, bbox_mapping = serialize_with_bbox_ids(docling_json)
    return bbox_mapping
