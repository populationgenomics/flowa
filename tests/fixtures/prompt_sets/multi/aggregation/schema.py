"""Synthetic two-category aggregation schema for fan-out tests.

Domain-neutral: the verdict field is an opaque ``verdict`` string, exercising the
scheme-agnostic contract (flowa stamps ``category`` and never validates the
verdict value). Mirrors the real-set convention of exposing ``CategoryResult`` by
name as a subclass of ``flowa.artifact.CategoryResult``.
"""

from pydantic import Field

from flowa.artifact import CategoryResult as BaseCategoryResult


class CategoryResult(BaseCategoryResult):
    """A single synthetic category result with an opaque verdict field."""

    verdict: str = Field(description='Opaque per-category verdict label.')
