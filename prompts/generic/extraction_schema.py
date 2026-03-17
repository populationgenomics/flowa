"""Extraction schema for generic ACMG-style variant assessment.

This module defines the output structure for individual paper extraction.
The ExtractionResult class is loaded dynamically by Flowa.

Interface requirements (accessed by Flowa's validation logic):
    - evidence[].citations[].quote must exist for fuzzy-match validation
"""

from pydantic import BaseModel, Field


class Citation(BaseModel):
    """A citation quoting a specific passage from the source document."""

    quote: str = Field(description='A short, distinctive verbatim quote from the paper text that identifies the evidence')
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
