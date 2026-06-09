"""Schema versioning and input-envelope models for flowa.

Increment a schema_version when a breaking change to that file's structure
lands (removing/renaming fields, changing field types, changing the
meaning of existing fields). Non-breaking additions (new optional fields)
do not require a bump.

Pydantic classes live here only for shapes that cross a trust boundary —
`VariantSpec` / `HgvsCVariant` arrive over HTTP or the CLI, and
`QueryResult` is the on-disk record we write and read back. The
normalised-variant dict produced by `flowa.normalize` is intentionally
untyped: its shape is documented in `normalize.py`. Pydantic classes for
the normalised shape would be inert plumbing whose only consumers (the
Jinja partial, the Mastermind / LitVar query builders, the extract /
aggregate stages) just read fields, and a missing key blows up as loudly
via `data['key']` as via `ValidationError`.
"""

from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

AGGREGATION_SCHEMA_VERSION = 2
METADATA_SCHEMA_VERSION = 1
QUERY_SCHEMA_VERSION = 2
VARIANT_SPEC_SCHEMA_VERSION = 1
NORMALIZED_VARIANT_SCHEMA_VERSION = 1


def with_schema_version(data: dict, version: int) -> dict:
    """Add schema_version to a dict for writing."""
    return {'schema_version': version, **data}


# --------------------------------------------------------------------------
# VariantSpec — input envelope across CLI and HTTP wires
# --------------------------------------------------------------------------


class HgvsCVariant(BaseModel):
    """A coding-DNA variant expressed in HGVS c. notation against a transcript.

    Phase B accepts NM_ transcripts; the normaliser (VEP REST) derives
    genomic and protein projections downstream. The `kind` field is
    required in JSON (no default) so future kinds extend the union without
    retro-fitting meaning onto existing payloads.

    `hgvs_c` is the c.-form alone (`c.14174A>G`), not the transcript-prefixed
    full expression. Callers that need the full HGVS string (VEP REST,
    Mastermind, LitVar, ClinVar) reconstruct it as
    ``f'{item.transcript}:{item.hgvs_c}'`` at the use site.
    """

    model_config = ConfigDict(extra='forbid')

    kind: Literal['hgvs_c']
    transcript: str = Field(..., min_length=1, description='e.g. NM_001035.3')
    hgvs_c: str = Field(..., min_length=1, description='c.-form only, no transcript prefix (e.g. c.14174A>G)')


# Single-member discriminated union, locked in advance for forward
# compatibility. When CNV / additional kinds land, widen to:
#     Annotated[HgvsCVariant | CnvVariant, Field(discriminator='kind')]
# Existing kind='hgvs_c' payloads keep validating unchanged.
VariantSpecItem = HgvsCVariant


class VariantSpec(BaseModel):
    """Generic input envelope.

    Phase B caps `variants` at exactly one item; the field is plural so
    multi-variant (e.g. compound heterozygous) extends by relaxing the cap.
    """

    model_config = ConfigDict(extra='forbid')

    schema_version: Literal[1] = 1
    variants: list[VariantSpecItem] = Field(..., min_length=1, max_length=1)


def parse_variant_spec_cli(raw: str) -> VariantSpec:
    """Parse a ``--variant-spec`` Typer argument.

    Accepts either inline JSON (``--variant-spec '{...}'``) or a path
    reference (``--variant-spec @path/to/spec.json``). The ``@``-prefix
    form is for local debugging and one-off scripts where typing the JSON
    inline is awkward.
    """
    if raw.startswith('@'):
        raw = Path(raw[1:]).read_text()
    return VariantSpec.model_validate_json(raw)


# --------------------------------------------------------------------------
# QueryResult — cached output of the query stage (assessments/<id>/query.json)
# --------------------------------------------------------------------------


class QueryResult(BaseModel):
    """Cached result of the query stage.

    The full HGVS expression and the gene symbol are not stored here:
    `variant_spec.variants[0]` already carries `transcript` + `hgvs_c`, and
    the gene symbol is on the normalised variant in `variant_details.json`.
    Callers that need either reconstruct on demand.
    """

    model_config = ConfigDict(extra='forbid')

    schema_version: Literal[2] = 2
    variant_spec: VariantSpec
    dois: list[str]
