"""Aggregate schema for generic ACMG-style variant assessment.

This module defines the output structure for aggregate assessment across papers.
The AggregateResult class is loaded dynamically by Flowa.

Interface requirements (accessed by Flowa's validation logic):
    - results[].category must exist
    - results[].claims[].paper_id and .citations[].quote must exist
    - results[].papers[].paper_id must exist

Strict structured outputs (Bedrock/Anthropic/OpenAI NativeOutput) clobber
additionalProperties to false, collapsing dict[str, X] fields to empty objects.
Use a list shape with the category carried as a field inside each entry.
"""

from pydantic import BaseModel, Field


class AggregateCitation(BaseModel):
    """A citation quoting a specific passage from a source paper."""

    quote: str = Field(
        description='A short, distinctive verbatim quote from the paper text that identifies this evidence.'
    )


class Claim(BaseModel):
    """A factual statement, aggregated across papers.

    Each claim originates from exactly one paper, carries one or more supporting
    quotes from that paper, and is the unit of triage for the curator.
    """

    paper_id: str = Field(description='AuthorYear identifier of the source paper; must appear in papers[]')
    text: str = Field(
        description='The factual statement as the curator reads it in triage. '
        'May synthesise across citations from the same paper (e.g. pedigree + patient id + measurement).'
    )
    citations: list[AggregateCitation] = Field(
        description='One or more supporting quotes from paper_id. '
        'Multiple citations on a single claim are appropriate only for synthesis claims; '
        'do not duplicate the same fact as separate claims.',
        min_length=1,
    )


class RankedPaper(BaseModel):
    """A paper in the ranked papers list. List position encodes importance."""

    paper_id: str = Field(description='AuthorYear identifier; must match the key used in paper_id_mapping')
    rank_rationale: str = Field(
        description='One sentence explaining why this paper sits at this rank '
        '(shown to the curator in the "Why this rank?" popover).'
    )


class CategoryResult(BaseModel):
    """Result for a single assessment category."""

    category: str = Field(description='Assessment category identifier (e.g., "acmg_classification")')
    classification: str = Field(
        description='ACMG classification: Pathogenic, Likely Pathogenic, VUS, Likely Benign, or Benign'
    )
    classification_rationale: str = Field(description='Brief explanation of why this classification was selected')
    description: str = Field(
        description='The mandatory template for the selected classification, filled in with specific details from the evidence'
    )
    notes: str = Field(
        description='Detailed curator-style synthesis in Markdown format. '
        'Use inline citation links [text](#cite:paper_id "verbatim quote") to reference specific paper evidence locations. '
        'Every cited (paper_id, quote) pair MUST match a claim whose paper_id and one of whose citations[].quote is '
        'byte-identical. Reference ClinVar evidence in prose without #cite: links. '
        'Structure: summary (classification rationale with ClinVar status, key evidence and why it is convincing, '
        'refuting evidence callout) -> supporting evidence (per-source) -> refuting evidence if any (per-source).'
    )
    papers: list[RankedPaper] = Field(
        description='Papers that contributed to the synthesis, ordered by importance (first = most important). '
        'List position IS the rank — no numeric ranks or tier labels. '
        'Every paper_id referenced by any claim must appear here.'
    )
    claims: list[Claim] = Field(
        description='Factual claims supporting the synthesis. Grouped by paper_id in the same order as papers[]; '
        'within each paper\'s group, ordered by importance (first = most load-bearing on the synthesis). '
        'Emit a claim only if its removal would force a materially different description or notes — '
        'background context and methodology-only detail is excluded.'
    )


class AggregateResult(BaseModel):
    """Multi-category aggregate result for ACMG-style variant assessment."""

    results: list[CategoryResult] = Field(
        description='List of assessment results, one per selected category. '
        'Each entry carries its own `category` identifier.'
    )
