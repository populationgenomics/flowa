-- Triage state for the demo. One row per workspace (variant + category +
-- artifact version), plus claim/comment/paper-done child tables keyed by
-- workspace_id. The workspace key is opaque to the React shells; we
-- serialise it as JSON and rely on a UNIQUE constraint to dedupe.

CREATE TABLE IF NOT EXISTS workspace (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_json TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS claim_state (
  workspace_id INTEGER NOT NULL,
  paper_id TEXT NOT NULL,
  claim_index INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('UNREVIEWED', 'ACCEPTED', 'REJECTED')),
  PRIMARY KEY (workspace_id, paper_id, claim_index),
  FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS claim_comment (
  workspace_id INTEGER NOT NULL,
  paper_id TEXT NOT NULL,
  claim_index INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (workspace_id, paper_id, claim_index),
  FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS paper_done (
  workspace_id INTEGER NOT NULL,
  paper_id TEXT NOT NULL,
  done_at TEXT NOT NULL,
  done_by TEXT NOT NULL,
  PRIMARY KEY (workspace_id, paper_id),
  FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE
);
