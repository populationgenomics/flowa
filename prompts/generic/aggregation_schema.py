"""Aggregation schema for generic ACMG-style variant assessment.

This module defines the output structure for aggregation across papers.
The AggregationResult class is loaded dynamically by Flowa.

Interface requirements (accessed by Flowa's validation logic):
    - results[].category must exist
    - results[].claims[].paper_id and .citations[].quote must exist
    - results[].papers[].paper_id must exist

Strict structured outputs (Bedrock/Anthropic/OpenAI NativeOutput) clobber
additionalProperties to false, collapsing dict[str, X] fields to empty objects.
Use a list shape with the category carried as a field inside each entry.
"""

from pydantic import BaseModel, Field

from flowa.artifact import CategoryResult as BaseCategoryResult


class CategoryResult(BaseCategoryResult):
    """ACMG-classification result for a single assessment category."""

    classification: str = Field(
        description='ACMG classification: Pathogenic, Likely Pathogenic, VUS, Likely Benign, or Benign.'
    )
    classification_rationale: str = Field(description='Brief explanation of why this classification was selected.')


class AggregationResult(BaseModel):
    """Multi-category aggregation result for ACMG-style variant assessment."""

    results: list[CategoryResult] = Field(
        description='List of assessment results, one per selected category. '
        'Each entry carries its own `category` identifier.'
    )
