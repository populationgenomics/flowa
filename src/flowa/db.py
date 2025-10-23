"""Database utilities for Flowa."""

import json
import sqlite3
from pathlib import Path
from typing import Any

DB_PATH = Path('data/db.sqlite')
SCHEMA_PATH = Path('schema.sql')


def _parse_bbox_mapping(bbox_mapping_json: str) -> dict[int, dict[str, Any]]:
    """Parse bbox_mapping JSON and convert string keys back to ints."""
    bbox_mapping = json.loads(bbox_mapping_json)
    return {int(k): v for k, v in bbox_mapping.items()}


def get_connection(db_path: Path = DB_PATH) -> sqlite3.Connection:
    """Get database connection with row factory."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def init_database(db_path: Path = DB_PATH) -> None:
    """Initialize database from schema.sql if it doesn't exist."""
    if db_path.exists():
        return

    # Ensure data directory exists
    db_path.parent.mkdir(parents=True, exist_ok=True)

    schema_sql = SCHEMA_PATH.read_text()
    conn = get_connection(db_path)
    conn.executescript(schema_sql)
    conn.commit()
    conn.close()


def create_variant(
    variant_id: str,
    gene: str,
    hgvs_c: str,
    db_path: Path = DB_PATH,
) -> None:
    """Create a new variant entry or update if exists."""
    init_database(db_path)
    conn = get_connection(db_path)
    cursor = conn.cursor()

    cursor.execute(
        """
        INSERT INTO variants (id, gene, hgvs_c)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            gene = excluded.gene,
            hgvs_c = excluded.hgvs_c,
            updated_at = CURRENT_TIMESTAMP
        """,
        (variant_id, gene, hgvs_c),
    )

    conn.commit()
    conn.close()


def get_variant(variant_id: str, db_path: Path = DB_PATH) -> dict[str, Any] | None:
    """Get variant by ID."""
    init_database(db_path)
    conn = get_connection(db_path)
    cursor = conn.cursor()

    cursor.execute('SELECT * FROM variants WHERE id = ?', (variant_id,))
    row = cursor.fetchone()
    conn.close()

    return dict(row) if row else None


def update_pmids(variant_id: str, pmids: list[int], db_path: Path = DB_PATH) -> None:
    """Update PMIDs for a variant."""
    init_database(db_path)
    conn = get_connection(db_path)
    cursor = conn.cursor()

    pmids_json = json.dumps(pmids)
    cursor.execute(
        """
        UPDATE variants
        SET pmids = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        (pmids_json, variant_id),
    )

    conn.commit()
    conn.close()


def save_individual_extraction(
    variant_id: str,
    pmid: int,
    raw_response: str,
    extraction_json: dict[str, Any],
    bbox_mapping: dict[int, dict[str, Any]],
    db_path: Path = DB_PATH,
) -> None:
    """Save individual paper extraction to database.

    Uses INSERT OR REPLACE to support resumability - if extraction already exists,
    it will be replaced with the new data.
    """
    init_database(db_path)
    conn = get_connection(db_path)
    cursor = conn.cursor()

    cursor.execute(
        """
        INSERT OR REPLACE INTO individual_extractions
        (variant_id, pmid, raw_response, extraction_json, bbox_mapping)
        VALUES (?, ?, ?, ?, ?)
        """,
        (
            variant_id,
            pmid,
            raw_response,
            json.dumps(extraction_json),
            json.dumps(bbox_mapping),
        ),
    )

    conn.commit()
    conn.close()


def get_individual_extraction(
    variant_id: str,
    pmid: int,
    db_path: Path = DB_PATH,
) -> dict[str, Any] | None:
    """Get individual extraction for a variant-PMID pair.

    Returns None if extraction doesn't exist (for resumability checks).
    """
    init_database(db_path)
    conn = get_connection(db_path)
    cursor = conn.cursor()

    cursor.execute(
        """
        SELECT variant_id, pmid, raw_response, extraction_json, bbox_mapping, created_at
        FROM individual_extractions
        WHERE variant_id = ? AND pmid = ?
        """,
        (variant_id, pmid),
    )
    row = cursor.fetchone()
    conn.close()

    if not row:
        return None

    result = dict(row)
    # Parse JSON fields
    result['extraction_json'] = json.loads(result['extraction_json'])
    result['bbox_mapping'] = _parse_bbox_mapping(result['bbox_mapping'])

    return result


def get_all_extractions_for_variant(
    variant_id: str,
    db_path: Path = DB_PATH,
) -> list[dict[str, Any]]:
    """Get all individual extractions for a variant.

    Returns list of extraction dicts, each containing parsed JSON.
    """
    init_database(db_path)
    conn = get_connection(db_path)
    cursor = conn.cursor()

    cursor.execute(
        """
        SELECT variant_id, pmid, raw_response, extraction_json, bbox_mapping, created_at
        FROM individual_extractions
        WHERE variant_id = ?
        ORDER BY pmid DESC
        """,
        (variant_id,),
    )
    rows = cursor.fetchall()
    conn.close()

    results = []
    for row in rows:
        result = dict(row)
        # Parse JSON fields
        result['extraction_json'] = json.loads(result['extraction_json'])
        result['bbox_mapping'] = _parse_bbox_mapping(result['bbox_mapping'])
        results.append(result)

    return results


def save_aggregate_assessment(
    variant_id: str,
    raw_response: str,
    assessment_json: dict[str, Any],
    db_path: Path = DB_PATH,
) -> None:
    """Save aggregate assessment to database.

    Uses INSERT OR REPLACE to support resumability.
    """
    init_database(db_path)
    conn = get_connection(db_path)
    cursor = conn.cursor()

    cursor.execute(
        """
        INSERT OR REPLACE INTO aggregate_assessments
        (variant_id, raw_response, assessment_json)
        VALUES (?, ?, ?)
        """,
        (variant_id, raw_response, json.dumps(assessment_json)),
    )

    conn.commit()
    conn.close()


def get_aggregate_assessment(
    variant_id: str,
    db_path: Path = DB_PATH,
) -> dict[str, Any] | None:
    """Get aggregate assessment for a variant.

    Returns None if assessment doesn't exist (for resumability checks).
    """
    init_database(db_path)
    conn = get_connection(db_path)
    cursor = conn.cursor()

    cursor.execute(
        """
        SELECT variant_id, raw_response, assessment_json, created_at
        FROM aggregate_assessments
        WHERE variant_id = ?
        """,
        (variant_id,),
    )
    row = cursor.fetchone()
    conn.close()

    if not row:
        return None

    result = dict(row)
    # Parse JSON field
    result['assessment_json'] = json.loads(result['assessment_json'])

    return result
