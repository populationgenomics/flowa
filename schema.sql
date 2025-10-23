-- Schema for Flowa variant literature assessment database

-- Core variants table (metadata only)
CREATE TABLE IF NOT EXISTS variants (
    id TEXT PRIMARY KEY,
    gene TEXT NOT NULL,
    hgvs_c TEXT NOT NULL,
    pmids TEXT CHECK(json_valid(pmids)),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Individual paper extractions (per variant-PMID pair)
CREATE TABLE IF NOT EXISTS individual_extractions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    variant_id TEXT NOT NULL,
    pmid INTEGER NOT NULL,
    raw_response TEXT NOT NULL,
    extraction_json JSON NOT NULL,
    bbox_mapping JSON NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(variant_id, pmid),
    FOREIGN KEY (variant_id) REFERENCES variants(id)
);

CREATE INDEX IF NOT EXISTS idx_individual_extractions_variant ON individual_extractions(variant_id);

-- Aggregate assessments (per variant)
CREATE TABLE IF NOT EXISTS aggregate_assessments (
    variant_id TEXT PRIMARY KEY,
    raw_response TEXT NOT NULL,
    assessment_json JSON NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (variant_id) REFERENCES variants(id)
);
