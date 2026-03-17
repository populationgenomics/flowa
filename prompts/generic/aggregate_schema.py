"""Aggregate schema for generic ACMG-style variant assessment.

This module defines the output structure for aggregate assessment across papers.
The AggregateResult class is loaded dynamically by Flowa.

Interface requirements (accessed by Flowa's validation logic):
    - results[category].citations[].paper_id and .quote must exist for validation
"""

from pydantic import BaseModel, Field


class AggregateCitation(BaseModel):
    """A citation quoting a specific passage from a source paper."""

    paper_id: str = Field(description='Paper ID (e.g. "Smith2024")')
    quote: str = Field(description='A short, distinctive verbatim quote from the paper text')
    commentary: str = Field(description='What this specific evidence states (appears as annotation in highlighted PDF)')


class CategoryResult(BaseModel):
    """Result for a single assessment category."""

    classification: str = Field(
        description='ACMG classification: Pathogenic, Likely Pathogenic, VUS, Likely Benign, or Benign'
    )
    classification_rationale: str = Field(description='Brief explanation of why this classification was selected')
    description: str = Field(description='Summary filled in with specific details from the evidence')
    notes: str = Field(
        description='Detailed curator-style synthesis in Markdown format. '
        'Use inline citation links [text](#cite:paper_id "verbatim quote") to reference specific paper evidence locations. '
        'Reference ClinVar evidence in prose without #cite: links. '
        'Structure: summary (classification rationale with ClinVar status, key evidence and why it is convincing, refuting evidence callout) '
        '-> supporting evidence (per-source) -> refuting evidence if any (per-source).'
    )
    citations: list[AggregateCitation] = Field(
        description='All citations supporting factual claims in the notes. '
        'Each #cite:paper_id link in the notes must have a corresponding entry here with the same paper_id and quote.'
    )


class AggregateResult(BaseModel):
    """Multi-category aggregate result for ACMG-style variant assessment.

    Keys are assessment category identifiers (e.g., 'acmg_classification').
    """

    results: dict[str, CategoryResult] = Field(
        description='Map from category identifier to the assessment result for that category'
    )
