"""Extraction schema for generic ACMG-style variant assessment.

This module defines the output structure for individual paper extraction.
The ExtractionResult class is loaded dynamically by Flowa.

Interface requirements (accessed by Flowa's validation logic):
    - evidence[].citations[].box_id must exist for bbox validation
"""

from pydantic import BaseModel, Field


class Citation(BaseModel):
    """A citation to a specific bbox in the source document."""

    box_id: int = Field(description='The bounding box ID from the source text')
    commentary: str = Field(
        description='What this specific text states/demonstrates (appears as annotation in highlighted PDF)'
    )


class EvidenceFinding(BaseModel):
    """A specific factual finding from the paper."""

    finding: str = Field(description='A specific factual claim about the variant from the paper')
    citations: list[Citation] = Field(description='Citations supporting this finding', min_length=1)


class ExtractionResult(BaseModel):
    """Result of evidence extraction from a single paper."""

    variant_discussed: bool = Field(description='Whether this specific variant is discussed in the paper')
    evidence: list[EvidenceFinding] = Field(description='List of evidence findings extracted from the paper')
