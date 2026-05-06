/**
 * Tests for `GET /api/runs/[runId]/progress`.
 *
 * The route reads the JSONL straight off disk; tests write fixture files
 * to a tmp dir, point DEMO_DATA_DIR at it, and invoke the handler with
 * stub Next.js request/response objects.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NextApiRequest, NextApiResponse } from "next";
import handler from "../src/pages/api/runs/[runId]/progress.js";

let dataRoot: string;
let originalDemoDataDir: string | undefined;
let originalCwd: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "flowa-demo-progress-"));
  originalDemoDataDir = process.env.DEMO_DATA_DIR;
  process.env.DEMO_DATA_DIR = dataRoot;
  // demoConfig.getDemoDataDir resolves against cwd; pin cwd so tests are
  // reproducible regardless of who runs them and from where.
  originalCwd = process.cwd();
  process.chdir(dataRoot);
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalDemoDataDir === undefined) {
    delete process.env.DEMO_DATA_DIR;
  } else {
    process.env.DEMO_DATA_DIR = originalDemoDataDir;
  }
  rmSync(dataRoot, { recursive: true, force: true });
});

interface CapturedResponse {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
}

function makeReq(method: string, runId: string): NextApiRequest {
  return { method, query: { runId } } as unknown as NextApiRequest;
}

function makeRes(): { res: NextApiResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = {
    statusCode: 0,
    body: undefined,
    headers: {},
  };
  const res = {
    status(code: number) {
      captured.statusCode = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
    setHeader(name: string, value: string) {
      captured.headers[name] = value;
      return this;
    },
    send(body: unknown) {
      captured.body = body;
      return this;
    },
  } as unknown as NextApiResponse;
  return { res, captured };
}

function writeProgressFile(runId: string, lines: object[]): void {
  const dir = join(dataRoot, "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "progress.jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
}

const VALID_RUN_ID = "0123456789abcdef0123456789abcdef";

describe("GET /api/runs/[runId]/progress", () => {
  test("rejects non-GET methods", async () => {
    const { res, captured } = makeRes();
    await handler(makeReq("POST", VALID_RUN_ID), res);
    expect(captured.statusCode).toBe(405);
  });

  test("rejects malformed runId", async () => {
    const { res, captured } = makeRes();
    await handler(makeReq("GET", "not-a-uuid"), res);
    expect(captured.statusCode).toBe(400);
  });

  test("rejects path traversal attempts in runId", async () => {
    const { res, captured } = makeRes();
    await handler(makeReq("GET", "../escape"), res);
    expect(captured.statusCode).toBe(400);
  });

  test("returns 404 when no progress file exists", async () => {
    const { res, captured } = makeRes();
    await handler(makeReq("GET", VALID_RUN_ID), res);
    expect(captured.statusCode).toBe(404);
  });

  test("returns parsed events with terminal=false while running", async () => {
    writeProgressFile(VALID_RUN_ID, [
      {
        timestamp: "2026-05-07T00:00:01.000+00:00",
        stage: "query",
        kind: "stage_started",
      },
      {
        timestamp: "2026-05-07T00:00:02.000+00:00",
        stage: "query",
        kind: "stage_done",
        done: 2,
        total: 2,
      },
    ]);
    const { res, captured } = makeRes();
    await handler(makeReq("GET", VALID_RUN_ID), res);
    expect(captured.statusCode).toBe(200);
    const body = captured.body as { events: unknown[]; terminal: boolean };
    expect(body.events).toHaveLength(2);
    expect(body.terminal).toBe(false);
  });

  test("sets terminal=true when last event is run_done", async () => {
    writeProgressFile(VALID_RUN_ID, [
      {
        timestamp: "2026-05-07T00:00:01.000+00:00",
        stage: "aggregate",
        kind: "run_done",
        detail: "ok",
      },
    ]);
    const { res, captured } = makeRes();
    await handler(makeReq("GET", VALID_RUN_ID), res);
    expect(captured.statusCode).toBe(200);
    expect((captured.body as { terminal: boolean }).terminal).toBe(true);
  });

  test("sets terminal=true when last event is run_error", async () => {
    writeProgressFile(VALID_RUN_ID, [
      {
        timestamp: "2026-05-07T00:00:01.000+00:00",
        stage: "aggregate",
        kind: "run_error",
        error: "boom",
      },
    ]);
    const { res, captured } = makeRes();
    await handler(makeReq("GET", VALID_RUN_ID), res);
    expect((captured.body as { terminal: boolean }).terminal).toBe(true);
  });
});
