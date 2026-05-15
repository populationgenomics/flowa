/**
 * Tests for `GET /api/papers?variantId=X`.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NextApiRequest, NextApiResponse } from "next";
import { encodeDoi } from "@flowajs/react-viewer";
import handler from "../src/pages/api/papers";

let dataRoot: string;
let originalDemoDataDir: string | undefined;
let originalCwd: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "flowa-demo-papers-route-"));
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

describe("GET /api/papers", () => {
  test("rejects non-GET", async () => {
    const { res, captured } = makeRes();
    await handler(makeReq("POST", "V1"), res);
    expect(captured.statusCode).toBe(405);
  });

  test("rejects missing variantId", async () => {
    const { res, captured } = makeRes();
    await handler(makeReq("GET"), res);
    expect(captured.statusCode).toBe(400);
  });

  test("rejects path-traversal variantId", async () => {
    const { res, captured } = makeRes();
    await handler(makeReq("GET", "../etc"), res);
    expect(captured.statusCode).toBe(400);
  });

  test("returns empty result when variant has no query.json", async () => {
    const { res, captured } = makeRes();
    await handler(makeReq("GET", "never-ran"), res);
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toEqual({
      papers: [],
      aggregateExists: false,
      categories: [],
      gene: null,
      hgvs_c: null,
    });
  });

  test("returns rows with derived statuses + aggregate signals", async () => {
    const doi = "10.1234/foo";
    const variant = "V1";

    mkdirSync(join(dataRoot, "assessments", variant), { recursive: true });
    writeFileSync(
      join(dataRoot, "assessments", variant, "query.json"),
      JSON.stringify({
        schema_version: 1,
        gene: "G",
        hgvs_c: "c.1A>T",
        dois: [doi],
      }),
    );
    writeFileSync(
      join(dataRoot, "assessments", variant, "aggregate.json"),
      JSON.stringify({
        schema_version: 1,
        results: [{ category: "acmg_classification" }],
      }),
    );
    const encoded = encodeDoi(doi);
    mkdirSync(join(dataRoot, "papers", encoded), { recursive: true });
    writeFileSync(join(dataRoot, "papers", encoded, "source.pdf"), "%PDF stub");

    const { res, captured } = makeRes();
    await handler(makeReq("GET", variant), res);
    expect(captured.statusCode).toBe(200);
    const body = captured.body as {
      papers: Array<{ doi: string; status: string }>;
      aggregateExists: boolean;
      categories: string[];
    };
    expect(body.papers[0]?.status).toBe("downloaded");
    expect(body.aggregateExists).toBe(true);
    expect(body.categories).toEqual(["acmg_classification"]);
  });
});
