/**
 * Round-trip tests for the SQLite triage backend. Each test gets its own
 * isolated tmp directory so concurrent runs cannot collide.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeAllDbs,
  getDb,
  loadSnapshot,
  setClaimComment,
  setClaimState,
  setPaperDone,
  type WorkspaceKey,
} from "../src/lib/triageDb";
import { migrate } from "../src/db/migrate";

const KEY: WorkspaceKey = {
  variantId: "NM_000152_5-c_1935C_A",
  category: "acmg_classification",
  version: 0,
};

let dbDir: string;
let dbPath: string;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "flowa-demo-triage-"));
  dbPath = join(dbDir, "triage.sqlite");
});

afterEach(() => {
  closeAllDbs();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("migrate", () => {
  test("creates the four expected tables", () => {
    const db = migrate(dbPath);
    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all() as { name: string }[];
    const names = rows.map((r) => r.name);
    expect(names).toContain("workspace");
    expect(names).toContain("claim_state");
    expect(names).toContain("claim_comment");
    expect(names).toContain("paper_done");
    db.close();
  });

  test("is idempotent across repeated calls", () => {
    migrate(dbPath).close();
    expect(() => migrate(dbPath).close()).not.toThrow();
  });
});

describe("loadSnapshot", () => {
  test("returns an empty snapshot for an unknown workspace", () => {
    const db = getDb(dbPath);
    const snapshot = loadSnapshot(db, KEY);
    expect(snapshot.claims).toEqual([]);
    expect(snapshot.comments).toEqual([]);
    expect(snapshot.papers).toEqual([]);
  });

  test("returns all state for a populated workspace", () => {
    const db = getDb(dbPath);
    setClaimState(db, KEY, "Smith2024", 0, "ACCEPTED");
    setClaimState(db, KEY, "Smith2024", 1, "REJECTED");
    setClaimComment(db, KEY, "Smith2024", 0, "agree");
    setPaperDone(db, KEY, "Smith2024", true, "leo@example.com");

    const snapshot = loadSnapshot(db, KEY);

    expect(snapshot.claims).toEqual(
      expect.arrayContaining([
        { paperId: "Smith2024", claimIndex: 0, state: "ACCEPTED" },
        { paperId: "Smith2024", claimIndex: 1, state: "REJECTED" },
      ]),
    );
    expect(snapshot.comments).toEqual([
      { paperId: "Smith2024", claimIndex: 0, body: "agree" },
    ]);
    expect(snapshot.papers).toHaveLength(1);
    expect(snapshot.papers[0]?.paperId).toBe("Smith2024");
    expect(snapshot.papers[0]?.triageDoneBy).toBe("leo@example.com");
    expect(snapshot.papers[0]?.triageDoneAt).toBeInstanceOf(Date);
  });
});

describe("setClaimState", () => {
  test("round-trips one state", () => {
    const db = getDb(dbPath);
    setClaimState(db, KEY, "Smith2024", 0, "ACCEPTED");
    const snapshot = loadSnapshot(db, KEY);
    expect(snapshot.claims).toEqual([
      { paperId: "Smith2024", claimIndex: 0, state: "ACCEPTED" },
    ]);
  });

  test("upserts on conflict", () => {
    const db = getDb(dbPath);
    setClaimState(db, KEY, "Smith2024", 0, "ACCEPTED");
    setClaimState(db, KEY, "Smith2024", 0, "REJECTED");
    const snapshot = loadSnapshot(db, KEY);
    expect(snapshot.claims).toEqual([
      { paperId: "Smith2024", claimIndex: 0, state: "REJECTED" },
    ]);
  });
});

describe("setClaimComment", () => {
  test("round-trips one comment", () => {
    const db = getDb(dbPath);
    setClaimComment(db, KEY, "Smith2024", 0, "needs follow-up");
    const snapshot = loadSnapshot(db, KEY);
    expect(snapshot.comments).toEqual([
      { paperId: "Smith2024", claimIndex: 0, body: "needs follow-up" },
    ]);
  });

  test("upserts on conflict", () => {
    const db = getDb(dbPath);
    setClaimComment(db, KEY, "Smith2024", 0, "first");
    setClaimComment(db, KEY, "Smith2024", 0, "second");
    const snapshot = loadSnapshot(db, KEY);
    expect(snapshot.comments).toEqual([
      { paperId: "Smith2024", claimIndex: 0, body: "second" },
    ]);
  });

  test("empty body deletes the row", () => {
    const db = getDb(dbPath);
    setClaimComment(db, KEY, "Smith2024", 0, "first");
    setClaimComment(db, KEY, "Smith2024", 0, "");
    const snapshot = loadSnapshot(db, KEY);
    expect(snapshot.comments).toEqual([]);
  });
});

describe("setPaperDone", () => {
  test("done=true persists timestamp + user", () => {
    const db = getDb(dbPath);
    const before = new Date();
    setPaperDone(db, KEY, "Smith2024", true, "leo@example.com");
    const snapshot = loadSnapshot(db, KEY);
    expect(snapshot.papers).toHaveLength(1);
    const row = snapshot.papers[0];
    expect(row?.paperId).toBe("Smith2024");
    expect(row?.triageDoneBy).toBe("leo@example.com");
    expect(row?.triageDoneAt.getTime()).toBeGreaterThanOrEqual(
      before.getTime() - 1,
    );
  });

  test("done=false removes the row", () => {
    const db = getDb(dbPath);
    setPaperDone(db, KEY, "Smith2024", true, "leo@example.com");
    setPaperDone(db, KEY, "Smith2024", false, "leo@example.com");
    const snapshot = loadSnapshot(db, KEY);
    expect(snapshot.papers).toEqual([]);
  });

  test("done=true twice updates done_by + done_at", () => {
    const db = getDb(dbPath);
    setPaperDone(db, KEY, "Smith2024", true, "first@example.com");
    setPaperDone(db, KEY, "Smith2024", true, "second@example.com");
    const snapshot = loadSnapshot(db, KEY);
    expect(snapshot.papers).toHaveLength(1);
    expect(snapshot.papers[0]?.triageDoneBy).toBe("second@example.com");
  });
});

describe("workspace key normalisation", () => {
  test("key field order does not create duplicate workspace rows", () => {
    const db = getDb(dbPath);
    const k1: WorkspaceKey = {
      variantId: "NM_000152_5-c_1935C_A",
      category: "acmg_classification",
      version: 0,
    };
    const k2: WorkspaceKey = {
      version: 0,
      category: "acmg_classification",
      variantId: "NM_000152_5-c_1935C_A",
    };
    setClaimState(db, k1, "Smith2024", 0, "ACCEPTED");
    setClaimState(db, k2, "Smith2024", 1, "REJECTED");
    const count = db.prepare("SELECT COUNT(*) AS c FROM workspace").get() as {
      c: number;
    };
    expect(count.c).toBe(1);
    const snapshot = loadSnapshot(db, k1);
    expect(snapshot.claims).toHaveLength(2);
  });

  test("different keys produce different workspaces", () => {
    const db = getDb(dbPath);
    const k1: WorkspaceKey = { variantId: "v1", category: "c", version: 0 };
    const k2: WorkspaceKey = { variantId: "v2", category: "c", version: 0 };
    setClaimState(db, k1, "p", 0, "ACCEPTED");
    setClaimState(db, k2, "p", 0, "REJECTED");
    expect(loadSnapshot(db, k1).claims[0]?.state).toBe("ACCEPTED");
    expect(loadSnapshot(db, k2).claims[0]?.state).toBe("REJECTED");
  });
});
