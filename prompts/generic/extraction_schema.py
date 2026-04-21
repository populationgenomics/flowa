"""Extraction schema for generic ACMG-style variant assessment.

This module defines the output structure for individual paper extraction.
The ExtractionResult class is loaded dynamically by Flowa.

Interface requirements (accessed by Flowa's validation logic):
    - claims[].citations[].quote must exist for fuzzy-match validation
"""

from pydantic import BaseModel, Field


class Citation(BaseModel):
    """A citation quoting a specific passage from the source document."""

    quote: str = Field(
        description='A short, distinctive verbatim quote from the paper text that identifies the evidence. '
        'Quotes must be at least 30 characters and distinguishable from other quotes in this paper.'
    )


class Claim(BaseModel):
    """A factual statement extracted from the paper, supported by one or more citations."""

    text: str = Field(
        description='The factual statement as the curator would read it in triage. '
        'May synthesise across citations (e.g. pedigree + patient id + measurement).'
    )
    citations: list[Citation] = Field(
        description='One or more supporting quotes from this paper. '
        'Emit multiple citations on a single claim only when several quotes jointly establish one fact; '
        'otherwise emit separate claims.',
        min_length=1,
    )


class ExtractionResult(BaseModel):
    """Result of evidence extraction from a single paper."""

    variant_discussed: bool = Field(description='Whether this specific variant is discussed in the paper')
    claims: list[Claim] = Field(description='List of factual claims extracted from the paper')
