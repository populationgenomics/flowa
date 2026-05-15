/**
 * Tests for `GET /api/runs/latest?variantId=X`.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NextApiRequest, NextApiResponse } from "next";
import handler from "../src/pages/api/runs/latest";

let dataRoot: string;
let originalDemoDataDir: string | undefined;
let originalCwd: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "flowa-demo-runs-latest-"));
  originalDemoDataDir = process.env.DEMO_DATA_DIR;
  process.env.DEMO_DATA_DIR = dataRoot;
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

function makeReq(method: string, variantId?: string): NextApiRequest {
  return {
    method,
    query: variantId !== undefined ? { variantId } : {},
  } as unknown as NextApiRequest;
}

function writeRun(
  variantId: string,
  runId: string,
  events: { timestamp: string; kind: string }[],
): void {
  const dir = join(dataRoot, "assessments", variantId, "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "progress.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
}

describe("GET /api/runs/latest", () => {
  test("rejects non-GET methods", async () => {
    const { res, captured } = makeRes();
    await handler(makeReq("POST", "V1"), res);
    expect(captured.statusCode).toBe(405);
  });

  test("returns 400 when variantId is missing", async () => {
    const { res, captured } = makeRes();
    await handler(makeReq("GET"), res);
    expect(captured.statusCode).toBe(400);
  });

  test("returns 400 for path-traversal variantId", async () => {
    const { res, captured } = makeRes();
    await handler(makeReq("GET", "../etc/passwd"), res);
    expect(captured.statusCode).toBe(400);
  });

  test("returns 404 when the variant has no runs", async () => {
    const { res, captured } = makeRes();
    await handler(makeReq("GET", "no-runs"), res);
    expect(captured.statusCode).toBe(404);
  });

  test("returns the most recent run with terminal flag", async () => {
    writeRun("V1", "a".repeat(32), [
      { timestamp: "2026-05-01T00:00:00.000+00:00", kind: "run_done" },
    ]);
    // Ensure b's mtime is strictly newer than a's.
    await new Promise((r) => setTimeout(r, 10));
    writeRun("V1", "b".repeat(32), [
      { timestamp: "2026-05-02T00:00:00.000+00:00", kind: "stage_started" },
    ]);

    const { res, captured } = makeRes();
    await handler(makeReq("GET", "V1"), res);
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toMatchObject({
      run_id: "b".repeat(32),
      terminal: false,
    });
  });
});
