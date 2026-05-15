/**
 * Filesystem-backed run discovery + history scan.
 *
 * The demo intentionally does not track a runs manifest: variant_id is
 * encoded in the storage path, and started_at + terminal can be read from
 * the first and last line of `progress.jsonl`. A real deployment would
 * back this by an indexed table; the demo's filesystem scan is good
 * enough for a developer's tens-of-runs working set and avoids a
 * separate writer / DB.
 *
 * Both helpers tolerate partial state: a run dir without a progress
 * file (gateway crashed before the first event) still surfaces as an
 * in-flight run; a variant dir without `query.json` (pipeline died
 * before the query stage finished) still produces history rows with
 * `gene` / `hgvs_c` set to `null`.
 */

import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { getDemoDataDir } from "./demoConfig";

export interface RunRow {
  run_id: string;
  variant_id: string;
  /** From `query.json`; null if the run died before the query stage. */
  gene: string | null;
  /** From `query.json`; null if the run died before the query stage. */
  hgvs_c: string | null;
  /** First event's timestamp; null when no events have landed yet. */
  started_at: string | null;
  terminal: boolean;
}

export interface RunsHistoryPage {
  runs: RunRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface RunsHistoryOptions {
  page: number;
  pageSize?: number;
  dataDir?: string;
}

export const DEFAULT_RUNS_PAGE_SIZE = 20;

interface QueryFile {
  gene?: string;
  hgvs_c?: string;
}

interface ProgressEvent {
  timestamp: string;
  kind: "stage_started" | "paper" | "stage_done" | "run_done" | "run_error";
}

async function readQueryGeneAndHgvsC(
  path: string,
): Promise<{ gene: string | null; hgvs_c: string | null }> {
  if (!existsSync(path)) return { gene: null, hgvs_c: null };
  const q = JSON.parse(await readFile(path, "utf8")) as QueryFile;
  return { gene: q.gene ?? null, hgvs_c: q.hgvs_c ?? null };
}

async function readProgressEndpoints(
  path: string,
): Promise<{ started_at: string | null; terminal: boolean }> {
  if (!existsSync(path)) return { started_at: null, terminal: false };
  const text = await readFile(path, "utf8");
  const lines = text.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return { started_at: null, terminal: false };
  const first = JSON.parse(lines[0]!) as ProgressEvent;
  const last = JSON.parse(lines[lines.length - 1]!) as ProgressEvent;
  return {
    started_at: first.timestamp ?? null,
    terminal: last.kind === "run_done" || last.kind === "run_error",
  };
}

/**
 * Scan every run under every variant. Used by both the paginated history
 * endpoint and the index page's render. Sorts descending by `started_at`
 * with nulls last (so an in-flight run that hasn't emitted yet still
 * appears at the bottom rather than disappearing).
 */
export async function scanRunsHistory(
  options: RunsHistoryOptions,
): Promise<RunsHistoryPage> {
  const page = options.page;
  const pageSize = options.pageSize ?? DEFAULT_RUNS_PAGE_SIZE;
  const dataDir = options.dataDir ?? getDemoDataDir();
  const assessmentsRoot = join(dataDir, "assessments");

  if (!existsSync(assessmentsRoot)) {
    return { runs: [], total: 0, page, pageSize };
  }

  const variantDirs = await readdir(assessmentsRoot);
  const all: RunRow[] = [];

  for (const variantId of variantDirs) {
    const runsRoot = join(assessmentsRoot, variantId, "runs");
    if (!existsSync(runsRoot)) continue;

    const { gene, hgvs_c } = await readQueryGeneAndHgvsC(
      join(assessmentsRoot, variantId, "query.json"),
    );

    const runDirs = await readdir(runsRoot);
    for (const run_id of runDirs) {
      const progressPath = join(runsRoot, run_id, "progress.jsonl");
      const { started_at, terminal } =
        await readProgressEndpoints(progressPath);
      all.push({
        run_id,
        variant_id: variantId,
        gene,
        hgvs_c,
        started_at,
        terminal,
      });
    }
  }

  all.sort((a, b) => {
    if (a.started_at === null && b.started_at === null) return 0;
    if (a.started_at === null) return 1;
    if (b.started_at === null) return -1;
    return a.started_at < b.started_at
      ? 1
      : a.started_at > b.started_at
        ? -1
        : 0;
  });

  const start = (page - 1) * pageSize;
  return {
    runs: all.slice(start, start + pageSize),
    total: all.length,
    page,
    pageSize,
  };
}

export interface LatestRunInfo {
  run_id: string;
  started_at: string | null;
  terminal: boolean;
}

/**
 * Locate the latest run for a single variant. "Latest" = directory with
 * the largest mtime under `assessments/{variantId}/runs/`. mtime updates
 * every time `ProgressSink` rewrites the JSONL file (atomic rename), so a
 * still-running run keeps its mtime fresh until it terminates.
 *
 * Returns null when the variant has no runs at all; never throws for a
 * run that exists but hasn't emitted any events yet (gateway crashed
 * after `start` returned but before the first event landed).
 */
export async function findLatestRun(
  variantId: string,
  options: { dataDir?: string } = {},
): Promise<LatestRunInfo | null> {
  const dataDir = options.dataDir ?? getDemoDataDir();
  const runsRoot = join(dataDir, "assessments", variantId, "runs");
  if (!existsSync(runsRoot)) return null;

  const dirs = await readdir(runsRoot);
  if (dirs.length === 0) return null;

  let bestRunId: string | null = null;
  let bestMtime = -Infinity;
  for (const run_id of dirs) {
    const st = await stat(join(runsRoot, run_id));
    if (!st.isDirectory()) continue;
    if (st.mtimeMs > bestMtime) {
      bestMtime = st.mtimeMs;
      bestRunId = run_id;
    }
  }
  if (bestRunId === null) return null;

  const { started_at, terminal } = await readProgressEndpoints(
    join(runsRoot, bestRunId, "progress.jsonl"),
  );
  return { run_id: bestRunId, started_at, terminal };
}
