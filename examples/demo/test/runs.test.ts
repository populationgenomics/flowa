/**
 * Tests for the filesystem-backed runs history + latest-run discovery.
 *
 * Each test builds a tmp `demo-data/` tree mirroring the production
 * layout (`assessments/{variant}/runs/{run}/progress.jsonl`,
 * `assessments/{variant}/query.json`) and asserts the scanner's output.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLatestRun, scanRunsHistory } from "../src/lib/runs";

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "flowa-demo-runs-"));
});

afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

function writeQuery(
  variantId: string,
  transcript: string,
  hgvs_c: string,
): void {
  const dir = join(dataRoot, "assessments", variantId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "query.json"),
    JSON.stringify({
      schema_version: 2,
      variant_spec: {
        schema_version: 1,
        variants: [{ kind: "hgvs_c", transcript, hgvs_c }],
      },
      dois: [],
    }),
  );
}

function writeRun(
  variantId: string,
  runId: string,
  events: { timestamp: string; kind: string }[],
  options: { mtime?: Date } = {},
): void {
  const dir = join(dataRoot, "assessments", variantId, "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "progress.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  if (options.mtime) {
    utimesSync(dir, options.mtime, options.mtime);
  }
}

describe("scanRunsHistory", () => {
  test("returns empty page when no assessments exist", async () => {
    const result = await scanRunsHistory({ page: 1, dataDir: dataRoot });
    expect(result).toEqual({ runs: [], total: 0, page: 1, pageSize: 20 });
  });

  test("returns one row per run across all variants", async () => {
    writeQuery("NM_001035_3-c_14174A_G", "NM_001035.3", "c.14174A>G");
    writeRun("NM_001035_3-c_14174A_G", "a".repeat(32), [
      { timestamp: "2026-05-01T00:00:00.000+00:00", kind: "stage_started" },
      { timestamp: "2026-05-01T00:01:00.000+00:00", kind: "run_done" },
    ]);
    writeRun("NM_001035_3-c_14174A_G", "b".repeat(32), [
      { timestamp: "2026-05-02T00:00:00.000+00:00", kind: "stage_started" },
    ]);

    const result = await scanRunsHistory({ page: 1, dataDir: dataRoot });
    expect(result.total).toBe(2);
    expect(result.runs).toHaveLength(2);
  });

  test("sorts descending by started_at", async () => {
    writeQuery("V1", "NM_000001.1", "c.1A>T");
    writeRun("V1", "1".padStart(32, "0"), [
      { timestamp: "2026-05-01T00:00:00.000+00:00", kind: "run_done" },
    ]);
    writeRun("V1", "2".padStart(32, "0"), [
      { timestamp: "2026-05-03T00:00:00.000+00:00", kind: "run_done" },
    ]);
    writeRun("V1", "3".padStart(32, "0"), [
      { timestamp: "2026-05-02T00:00:00.000+00:00", kind: "run_done" },
    ]);

    const result = await scanRunsHistory({ page: 1, dataDir: dataRoot });
    expect(result.runs.map((r) => r.started_at)).toEqual([
      "2026-05-03T00:00:00.000+00:00",
      "2026-05-02T00:00:00.000+00:00",
      "2026-05-01T00:00:00.000+00:00",
    ]);
  });

  test("assembles colon-glued hgvs_c from variant_spec in sibling query.json", async () => {
    writeQuery("NM_001035_3-c_14174A_G", "NM_001035.3", "c.14174A>G");
    writeRun("NM_001035_3-c_14174A_G", "a".repeat(32), [
      { timestamp: "2026-05-01T00:00:00.000+00:00", kind: "run_done" },
    ]);

    const result = await scanRunsHistory({ page: 1, dataDir: dataRoot });
    expect(result.runs[0]).toMatchObject({
      hgvs_c: "NM_001035.3:c.14174A>G",
    });
  });

  test("returns null hgvs_c when the run died before query.json existed", async () => {
    writeRun("ghost", "a".repeat(32), [
      { timestamp: "2026-05-01T00:00:00.000+00:00", kind: "run_error" },
    ]);

    const result = await scanRunsHistory({ page: 1, dataDir: dataRoot });
    expect(result.runs[0]).toMatchObject({ hgvs_c: null });
  });

  test("marks runs terminal when last event is run_done or run_error", async () => {
    writeQuery("V1", "NM_000001.1", "c.1A>T");
    writeRun("V1", "a".repeat(32), [
      { timestamp: "2026-05-01T00:00:00.000+00:00", kind: "run_done" },
    ]);
    writeRun("V1", "b".repeat(32), [
      { timestamp: "2026-05-02T00:00:00.000+00:00", kind: "run_error" },
    ]);
    writeRun("V1", "c".repeat(32), [
      { timestamp: "2026-05-03T00:00:00.000+00:00", kind: "stage_started" },
    ]);

    const result = await scanRunsHistory({ page: 1, dataDir: dataRoot });
    const byRun = new Map(result.runs.map((r) => [r.run_id, r]));
    expect(byRun.get("a".repeat(32))!.terminal).toBe(true);
    expect(byRun.get("b".repeat(32))!.terminal).toBe(true);
    expect(byRun.get("c".repeat(32))!.terminal).toBe(false);
  });

  test("paginates with page and pageSize", async () => {
    writeQuery("V1", "NM_000001.1", "c.1A>T");
    for (let i = 0; i < 25; i++) {
      const day = (i + 1).toString().padStart(2, "0");
      writeRun("V1", i.toString(16).padStart(32, "0"), [
        { timestamp: `2026-05-${day}T00:00:00.000+00:00`, kind: "run_done" },
      ]);
    }

    const page1 = await scanRunsHistory({
      page: 1,
      pageSize: 20,
      dataDir: dataRoot,
    });
    expect(page1.runs).toHaveLength(20);
    expect(page1.total).toBe(25);

    const page2 = await scanRunsHistory({
      page: 2,
      pageSize: 20,
      dataDir: dataRoot,
    });
    expect(page2.runs).toHaveLength(5);
    expect(page2.total).toBe(25);

    // No overlap between pages.
    const ids1 = new Set(page1.runs.map((r) => r.run_id));
    for (const row of page2.runs) {
      expect(ids1.has(row.run_id)).toBe(false);
    }
  });

  test("handles a run dir with no progress.jsonl yet", async () => {
    writeQuery("V1", "NM_000001.1", "c.1A>T");
    mkdirSync(join(dataRoot, "assessments", "V1", "runs", "a".repeat(32)), {
      recursive: true,
    });

    const result = await scanRunsHistory({ page: 1, dataDir: dataRoot });
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({
      started_at: null,
      terminal: false,
    });
  });
});

describe("findLatestRun", () => {
  test("returns null when the variant has no runs", async () => {
    const result = await findLatestRun("missing", { dataDir: dataRoot });
    expect(result).toBeNull();
  });

  test("returns the run with the largest mtime", async () => {
    writeRun(
      "V1",
      "old".padStart(32, "0"),
      [{ timestamp: "2026-05-01T00:00:00.000+00:00", kind: "run_done" }],
      { mtime: new Date("2026-05-01T00:00:00Z") },
    );
    writeRun(
      "V1",
      "new".padStart(32, "0"),
      [{ timestamp: "2026-05-02T00:00:00.000+00:00", kind: "stage_started" }],
      { mtime: new Date("2026-05-02T00:00:00Z") },
    );

    const result = await findLatestRun("V1", { dataDir: dataRoot });
    expect(result?.run_id).toBe("new".padStart(32, "0"));
    expect(result?.terminal).toBe(false);
  });

  test("returns the run even when no progress events have landed yet", async () => {
    mkdirSync(join(dataRoot, "assessments", "V1", "runs", "a".repeat(32)), {
      recursive: true,
    });
    const result = await findLatestRun("V1", { dataDir: dataRoot });
    expect(result).toMatchObject({
      run_id: "a".repeat(32),
      started_at: null,
      terminal: false,
    });
  });
});
