"""Aggregate schema for generic ACMG-style variant assessment.

This module defines the output structure for aggregate assessment across papers.
The AggregateResult class is loaded dynamically by Flowa.

Interface requirements (accessed by Flowa's validation logic):
    - citations[].pmid and citations[].box_id must exist for bbox validation
"""

from pydantic import BaseModel, Field


class AggregateCitation(BaseModel):
    """A citation to a specific bbox in a source paper."""

    pmid: int = Field(description='PubMed ID of the source paper')
    box_id: int = Field(description='The bounding box ID from the source text in the paper')
    commentary: str = Field(description='What this specific evidence states (appears as annotation in highlighted PDF)')


class AggregateResult(BaseModel):
    """Result of aggregate assessment across all papers."""

    classification: str = Field(
        description='ACMG classification: Pathogenic, Likely Pathogenic, VUS, Likely Benign, or Benign'
    )
    classification_rationale: str = Field(description='Brief explanation of why this classification was selected')
    description: str = Field(description='The mandatory template filled in with specific details from the evidence')
    notes: str = Field(description='Detailed curator-style synthesis in Markdown format')
    citations: list[AggregateCitation] = Field(
        description='All citations supporting factual claims in the detailed notes'
    )
