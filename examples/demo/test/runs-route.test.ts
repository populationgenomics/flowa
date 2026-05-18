/**
 * Tests for `POST /api/runs` + `GET /api/runs?page=N`.
 *
 * POST is verified by stubbing `fetch` so we can capture the body that
 * lands on demo-gateway; GET is verified by writing tmp fixture runs
 * and asserting the pagination math.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NextApiRequest, NextApiResponse } from "next";
import handler from "../src/pages/api/runs";

let dataRoot: string;
let originalDemoDataDir: string | undefined;
let originalGatewayUrl: string | undefined;
let originalCwd: string;
let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "flowa-demo-runs-route-"));
  originalDemoDataDir = process.env.DEMO_DATA_DIR;
  originalGatewayUrl = process.env.DEMO_GATEWAY_URL;
  process.env.DEMO_DATA_DIR = dataRoot;
  process.env.DEMO_GATEWAY_URL = "http://gateway.test";
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
  if (originalGatewayUrl === undefined) {
    delete process.env.DEMO_GATEWAY_URL;
  } else {
    process.env.DEMO_GATEWAY_URL = originalGatewayUrl;
  }
  if (fetchSpy) {
    fetchSpy.mockRestore();
    fetchSpy = null;
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

function postReq(body: unknown): NextApiRequest {
  return { method: "POST", query: {}, body } as unknown as NextApiRequest;
}

function getReq(query: Record<string, string> = {}): NextApiRequest {
  return { method: "GET", query } as unknown as NextApiRequest;
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

describe("POST /api/runs", () => {
  test("derives variant_id server-side and wraps {variant_id, variant_spec}", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          run_id: "abc",
          variant_id: "NM_001035_3-c_14174A_G",
          started_at: "2026-05-15T00:00:00.000+00:00",
          status: "running",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const { res, captured } = makeRes();
    await handler(
      postReq({ transcript: "NM_001035.3", hgvs_c: "c.14174A>G" }),
      res,
    );

    expect(captured.statusCode).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("http://gateway.test/runs");
    const sentBody = JSON.parse((init as { body: string }).body);
    expect(sentBody).toEqual({
      variant_id: "NM_001035_3-c_14174A_G",
      variant_spec: {
        schema_version: 1,
        variants: [
          {
            kind: "hgvs_c",
            transcript: "NM_001035.3",
            hgvs_c: "c.14174A>G",
          },
        ],
      },
    });
  });

  test("forwards demo-gateway 409 status through to the browser", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "run already in flight" }), {
        status: 409,
      }),
    );

    const { res, captured } = makeRes();
    await handler(
      postReq({ transcript: "NM_001035.3", hgvs_c: "c.14174A>G" }),
      res,
    );
    expect(captured.statusCode).toBe(409);
  });

  test("rejects requests missing transcript", async () => {
    const { res, captured } = makeRes();
    await handler(postReq({ hgvs_c: "c.1A>T" }), res);
    expect(captured.statusCode).toBe(400);
  });

  test("rejects requests missing hgvs_c", async () => {
    const { res, captured } = makeRes();
    await handler(postReq({ transcript: "NM_001035.3" }), res);
    expect(captured.statusCode).toBe(400);
  });

  test("rejects empty-string fields", async () => {
    const { res, captured } = makeRes();
    await handler(postReq({ transcript: "", hgvs_c: "" }), res);
    expect(captured.statusCode).toBe(400);
  });
});

describe("GET /api/runs", () => {
  test("returns an empty page when no assessments exist", async () => {
    const { res, captured } = makeRes();
    await handler(getReq({}), res);
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toMatchObject({ runs: [], total: 0, page: 1 });
  });

  test("returns runs sorted descending by started_at with hgvs_c join", async () => {
    writeQuery("NM_001035_3-c_14174A_G", "NM_001035.3", "c.14174A>G");
    writeRun("NM_001035_3-c_14174A_G", "a".repeat(32), [
      { timestamp: "2026-05-01T00:00:00.000+00:00", kind: "run_done" },
    ]);
    writeRun("NM_001035_3-c_14174A_G", "b".repeat(32), [
      { timestamp: "2026-05-02T00:00:00.000+00:00", kind: "run_done" },
    ]);

    const { res, captured } = makeRes();
    await handler(getReq({}), res);
    const body = captured.body as {
      runs: Array<{ run_id: string; started_at: string; hgvs_c: string }>;
    };
    expect(body.runs[0]?.started_at).toBe("2026-05-02T00:00:00.000+00:00");
    expect(body.runs[0]?.hgvs_c).toBe("NM_001035.3:c.14174A>G");
  });

  test("rejects malformed page parameter", async () => {
    const { res, captured } = makeRes();
    await handler(getReq({ page: "0" }), res);
    expect(captured.statusCode).toBe(400);
  });
});

describe("/api/runs method dispatch", () => {
  test("rejects PATCH with 405", async () => {
    const { res, captured } = makeRes();
    const req = {
      method: "PATCH",
      query: {},
      body: {},
    } as unknown as NextApiRequest;
    await handler(req, res);
    expect(captured.statusCode).toBe(405);
  });
});
