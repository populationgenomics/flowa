/**
 * Server-side triage operations over `node:sqlite`. The HTTP routes under
 * `pages/api/triage/` call into here; the client-side `TriageBackend`
 * implementation (which lives in `@flowajs/react-viewer` once the shell
 * lands) calls those routes.
 *
 * The shape of the DB exchange — `WorkspaceKey` opaque to the shell, four
 * operations (loadSnapshot, setClaimState, setClaimComment,
 * setPaperDone) — mirrors the public TriageBackend interface to keep the
 * API surface stable.
 */

import { DatabaseSync } from "node:sqlite";
import { migrate } from "../db/migrate.js";

export type TriageStateValue = "UNREVIEWED" | "ACCEPTED" | "REJECTED";
export type WorkspaceKey = Record<string, string | number>;

export interface ClaimStateRow {
  paperId: string;
  claimIndex: number;
  state: TriageStateValue;
}

export interface ClaimCommentRow {
  paperId: string;
  claimIndex: number;
  body: string;
}

export interface PaperDoneRow {
  paperId: string;
  triageDoneAt: Date;
  triageDoneBy: string;
}

export interface TriageSnapshot {
  claims: ClaimStateRow[];
  comments: ClaimCommentRow[];
  papers: PaperDoneRow[];
}

/** Lazy DB handle, keyed by absolute path to allow per-test isolation. */
const dbCache = new Map<string, DatabaseSync>();

export function getDb(dbPath: string): DatabaseSync {
  let db = dbCache.get(dbPath);
  if (db) return db;
  db = migrate(dbPath);
  dbCache.set(dbPath, db);
  return db;
}

/** For tests / shutdown: close all cached handles. */
export function closeAllDbs(): void {
  for (const db of dbCache.values()) db.close();
  dbCache.clear();
}

/**
 * JSON-serialise the workspace key with sorted keys so structurally equal
 * keys produce byte-identical strings (the workspace.key_json column has a
 * UNIQUE constraint, so any ordering drift would make duplicates).
 */
function serialiseKey(key: WorkspaceKey): string {
  const sortedKeys = Object.keys(key).sort();
  const ordered: WorkspaceKey = {};
  for (const k of sortedKeys) {
    const v = key[k];
    if (v === undefined) continue;
    ordered[k] = v;
  }
  return JSON.stringify(ordered);
}

function ensureWorkspaceId(db: DatabaseSync, keyJson: string): number {
  const existing = db
    .prepare("SELECT id FROM workspace WHERE key_json = ?")
    .get(keyJson) as { id: number } | undefined;
  if (existing) return existing.id;
  const insert = db
    .prepare("INSERT INTO workspace (key_json) VALUES (?)")
    .run(keyJson);
  return Number(insert.lastInsertRowid);
}

export function loadSnapshot(
  db: DatabaseSync,
  key: WorkspaceKey,
): TriageSnapshot {
  const keyJson = serialiseKey(key);
  const ws = db
    .prepare("SELECT id FROM workspace WHERE key_json = ?")
    .get(keyJson) as { id: number } | undefined;
  if (!ws) {
    return { claims: [], comments: [], papers: [] };
  }

  const claims = db
    .prepare(
      "SELECT paper_id AS paperId, claim_index AS claimIndex, state FROM claim_state WHERE workspace_id = ?",
    )
    .all(ws.id) as unknown as ClaimStateRow[];

  const comments = db
    .prepare(
      "SELECT paper_id AS paperId, claim_index AS claimIndex, body FROM claim_comment WHERE workspace_id = ?",
    )
    .all(ws.id) as unknown as ClaimCommentRow[];

  const paperRows = db
    .prepare(
      "SELECT paper_id AS paperId, done_at AS doneAt, done_by AS doneBy FROM paper_done WHERE workspace_id = ?",
    )
    .all(ws.id) as unknown as {
    paperId: string;
    doneAt: string;
    doneBy: string;
  }[];

  const papers = paperRows.map((r) => ({
    paperId: r.paperId,
    triageDoneAt: new Date(r.doneAt),
    triageDoneBy: r.doneBy,
  }));

  return { claims, comments, papers };
}

export function setClaimState(
  db: DatabaseSync,
  key: WorkspaceKey,
  paperId: string,
  claimIndex: number,
  state: TriageStateValue,
): void {
  const wsId = ensureWorkspaceId(db, serialiseKey(key));
  db.prepare(
    `INSERT INTO claim_state (workspace_id, paper_id, claim_index, state)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (workspace_id, paper_id, claim_index)
     DO UPDATE SET state = excluded.state`,
  ).run(wsId, paperId, claimIndex, state);
}

export function setClaimComment(
  db: DatabaseSync,
  key: WorkspaceKey,
  paperId: string,
  claimIndex: number,
  body: string,
): void {
  const wsId = ensureWorkspaceId(db, serialiseKey(key));
  if (body === "") {
    db.prepare(
      "DELETE FROM claim_comment WHERE workspace_id = ? AND paper_id = ? AND claim_index = ?",
    ).run(wsId, paperId, claimIndex);
    return;
  }
  db.prepare(
    `INSERT INTO claim_comment (workspace_id, paper_id, claim_index, body)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (workspace_id, paper_id, claim_index)
     DO UPDATE SET body = excluded.body`,
  ).run(wsId, paperId, claimIndex, body);
}

export function setPaperDone(
  db: DatabaseSync,
  key: WorkspaceKey,
  paperId: string,
  done: boolean,
  user: string,
): void {
  const wsId = ensureWorkspaceId(db, serialiseKey(key));
  if (!done) {
    db.prepare(
      "DELETE FROM paper_done WHERE workspace_id = ? AND paper_id = ?",
    ).run(wsId, paperId);
    return;
  }
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO paper_done (workspace_id, paper_id, done_at, done_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (workspace_id, paper_id)
     DO UPDATE SET done_at = excluded.done_at, done_by = excluded.done_by`,
  ).run(wsId, paperId, now, user);
}
