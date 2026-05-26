"""Shared schema primitives for aggregation prompt sets.

`CategoryResult` is the citation-grounded base each deployment derives from
to add its own classification field(s) — e.g. generic ACMG sets add
`classification` + `classification_rationale`; private deployments may add
their own classification dimensions. Each deployment also defines its own
`AggregationResult` with `results: list[CategoryResult]` pointing at its
own `CategoryResult` subclass (Pydantic doesn't covariantly substitute the
parent's parameterised generic).

This module is the Python analog of `@flowajs/chat-service`'s
`artifactFields` / `ArtifactSchema` export: it exists so prompt-set schemas
share their citation-grounded structure rather than duplicating it.

The schema-side descriptions here are deliberately structural — they
describe what each field IS. Behavioural guidance (how to populate
`description`, ranking conventions, claim-emission criteria) belongs in the
aggregation prompt template, not the schema.
"""

from pydantic import BaseModel, Field


class AggregateCitation(BaseModel):
    """A citation quoting a specific passage from a source paper."""

    quote: str = Field(
        description='A short, distinctive verbatim quote from the paper text that identifies this evidence.'
    )


class Claim(BaseModel):
    """A factual statement supporting a synthesis, sourced from one paper."""

    paper_id: str = Field(description='AuthorYear identifier of the source paper; must appear in papers[].')
    text: str = Field(
        description='The factual statement as the curator reads it in triage. '
        'May synthesise across citations from the same paper.'
    )
    citations: list[AggregateCitation] = Field(
        description='One or more supporting quotes from paper_id.',
        min_length=1,
    )


class RankedPaper(BaseModel):
    """A paper in the ranked papers list. List position encodes importance."""

    paper_id: str = Field(description='AuthorYear identifier; must match the key used in paper_id_mapping.')
    rank_rationale: str = Field(description='One sentence explaining why this paper sits at this rank.')


class CategoryResult(BaseModel):
    """Citation-grounded base for an aggregation result.

    Deployments subclass to add classification-specific fields. The five
    fields here are the contract that `flowa.aggregate` reads at validation
    time.
    """

    category: str = Field(description='Assessment-category identifier.')
    description: str = Field(description='Short human-readable summary of the synthesis.')
    notes: str = Field(
        description='Long-form synthesis in Markdown. Uses inline citation links: '
        '[text](#cite:paper_id "verbatim quote") to reference specific paper evidence locations.'
    )
    papers: list[RankedPaper] = Field(
        description='Source documents contributing to the synthesis, ordered by importance. '
        'List position is the rank; paper_id values must be unique.'
    )
    claims: list[Claim] = Field(
        description='Factual claims supporting the synthesis, grouped by paper_id in the same order as papers[].'
    )
