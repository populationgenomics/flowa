"""Aggregation output schema for the generic ACMG-style assessment.

flowa's aggregate step fans out one subagent per category declared in
``categories.json``; each subagent emits a single ``CategoryResult`` (loaded here by
name, mirroring extraction's ``ExtractionResult`` convention), and flowa assembles the
per-category results into the top-level artifact itself.

``category`` is engine-authoritative: flowa stamps each assembled result with the id of
the category it dispatched, so the model's own value for that field is advisory. flowa
treats the verdict field (``classification`` here) as an opaque string — it does not
enumerate or validate the allowed values.

Interface (read by flowa's validation + assembly logic):
    - CategoryResult.papers[].paper_id
    - CategoryResult.claims[].paper_id and .citations[].quote
"""

from pydantic import Field

from flowa.artifact import CategoryResult as BaseCategoryResult


class CategoryResult(BaseCategoryResult):
    """ACMG-classification result for a single assessment category."""

    classification: str = Field(
        description='ACMG classification: Pathogenic, Likely Pathogenic, VUS, Likely Benign, or Benign.'
    )
    classification_rationale: str = Field(
        description='One short clause naming the deciding factor for this classification.'
    )
