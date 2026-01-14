"""
Schema versioning for Flowa output files.

Increment the relevant version when making breaking changes to that file's structure.
Breaking changes include: removing fields, renaming fields, changing field types,
changing the meaning of existing fields.

Non-breaking changes (adding new optional fields) don't require version bumps.
"""

AGGREGATE_SCHEMA_VERSION = 1
QUERY_SCHEMA_VERSION = 1
METADATA_SCHEMA_VERSION = 1


def with_schema_version(data: dict, version: int) -> dict:
    """Add schema_version to a dict for writing."""
    return {'schema_version': version, **data}
