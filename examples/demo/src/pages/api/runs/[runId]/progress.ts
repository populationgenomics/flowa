/**
 * GET /api/runs/[runId]/progress
 *
 * Reads the run's `progress.jsonl` directly from the shared local fs
 * (the same file demo-gateway is appending to). Same machine, same fs,
 * so no proxy is involved or needed.
 *
 * Why this route lives in Next.js rather than on the gateway: the demo
 * fronts every "static-like" surface through Next.js (assets, pages,
 * triage state, progress) so the browser only has two URLs to think
 * about — same-origin Next.js for state-fetch and direct chat-service
 * / demo-gateway for actions. Reading the JSONL doesn't need the
 * gateway's awareness either; the file is canonical on disk.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { NextApiRequest, NextApiResponse } from "next";
import { getDemoDataDir } from "@/lib/demoConfig";

// run_id is a uuid4 hex (32 lowercase hex chars). Validating before we
// build a path keeps a malicious request from escaping ./demo-data/runs/.
const RUN_ID_RE = /^[0-9a-f]{32}$/;

interface ProgressEvent {
  timestamp: string;
  stage: "query" | "download" | "convert" | "extract" | "aggregate";
  kind: "stage_started" | "paper" | "stage_done" | "run_done" | "run_error";
  paper_id: string | null;
  done: number | null;
  total: number | null;
  detail: string | null;
  error: string | null;
}

interface ProgressResponse {
  events: ProgressEvent[];
  terminal: boolean;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { runId } = req.query;
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) {
    res.status(400).json({ error: "Invalid runId" });
    return;
  }

  const filePath = join(getDemoDataDir(), "runs", runId, "progress.jsonl");

  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { code?: unknown }).code === "ENOENT"
    ) {
      res.status(404).json({ error: "No progress for this run" });
      return;
    }
    throw err;
  }

  const events: ProgressEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    events.push(JSON.parse(line) as ProgressEvent);
  }
  const last = events[events.length - 1];
  const terminal =
    last !== undefined &&
    (last.kind === "run_done" || last.kind === "run_error");

  const body: ProgressResponse = { events, terminal };
  res.status(200).json(body);
}
