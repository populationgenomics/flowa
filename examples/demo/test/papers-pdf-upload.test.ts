/**
 * Tests for `POST /api/papers/[doi]/pdf`.
 *
 * formidable's multipart parser is exercised by its own test suite —
 * we mock the parser here and assert what the upload route does with
 * the parsed result: rename the staged temp file to the canonical
 * on-disk path, return `{ ok, doi, size }`, and surface a 400 when no
 * file was attached.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { NextApiRequest, NextApiResponse } from "next";
import { encodeDoi } from "@flowajs/react-viewer";

let dataRoot: string;
let originalDemoDataDir: string | undefined;
let originalCwd: string;

interface MockParseResult {
  files: Record<string, { filepath: string }[]>;
}

type ParseCallback = (err: unknown, fields: unknown, files: unknown) => void;

const mockParseImpl = vi.fn<(req: unknown, callback: ParseCallback) => void>();

vi.mock("formidable", () => {
  const factory = vi.fn(() => ({
    parse: mockParseImpl,
  }));
  return { default: factory };
});

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "flowa-demo-pdf-upload-"));
  originalDemoDataDir = process.env.DEMO_DATA_DIR;
  process.env.DEMO_DATA_DIR = dataRoot;
  originalCwd = process.cwd();
  process.chdir(dataRoot);
  mockParseImpl.mockReset();
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

function postReq(doi: string): NextApiRequest {
  // The route never inspects the body when formidable is mocked — the
  // parser's callback is the only path that returns parsed values.
  return {
    method: "POST",
    query: { doi },
    headers: {},
  } as unknown as NextApiRequest;
}

function arrangeMockParse(result: MockParseResult): void {
  mockParseImpl.mockImplementation((_req, callback) => {
    callback(null, {}, result.files);
  });
}

function arrangeMockParseError(message: string): void {
  mockParseImpl.mockImplementation((_req, callback) => {
    callback(new Error(message), {}, {});
  });
}

describe("POST /api/papers/[doi]/pdf", () => {
  test("rejects unsupported methods", async () => {
    const { default: handler } =
      await import("../src/pages/api/papers/[doi]/pdf");
    const { res, captured } = makeRes();
    const req = {
      method: "PATCH",
      query: { doi: "10.1234/foo" },
      headers: {},
    } as unknown as NextApiRequest;
    await handler(req, res);
    expect(captured.statusCode).toBe(405);
  });

  test("renames the staged temp file to the canonical on-disk path", async () => {
    const { default: handler } =
      await import("../src/pages/api/papers/[doi]/pdf");
    const doi = "10.1371/journal.pone.0131517";

    // Stage a temp PDF inside the destination dir so the route's rename
    // stays on the same filesystem (matching real-world formidable
    // behaviour with `uploadDir` set).
    const stagingDir = join(dataRoot, "papers", encodeDoi(doi));
    mkdirSync(stagingDir, { recursive: true });
    const tmpFile = join(stagingDir, "uploaded.tmp");
    const contents = Buffer.from("%PDF-1.7 stub\n");
    writeFileSync(tmpFile, contents);

    arrangeMockParse({ files: { file: [{ filepath: tmpFile }] } });

    const { res, captured } = makeRes();
    await handler(postReq(doi), res);

    expect(captured.statusCode).toBe(200);
    expect(captured.body).toMatchObject({
      ok: true,
      doi,
      size: contents.length,
    });
    const destPath = join(stagingDir, "main.pdf");
    expect(existsSync(destPath)).toBe(true);
    expect(readFileSync(destPath)).toEqual(contents);
    expect(existsSync(tmpFile)).toBe(false);
  });

  test("400 when formidable signals no file was attached", async () => {
    const { default: handler } =
      await import("../src/pages/api/papers/[doi]/pdf");
    arrangeMockParse({ files: {} });

    const { res, captured } = makeRes();
    await handler(postReq("10.1234/foo"), res);
    expect(captured.statusCode).toBe(400);
  });

  test("400 when formidable raises during parse", async () => {
    const { default: handler } =
      await import("../src/pages/api/papers/[doi]/pdf");
    arrangeMockParseError("file too large");

    const { res, captured } = makeRes();
    await handler(postReq("10.1234/foo"), res);
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toMatchObject({ error: "file too large" });
  });
});

// GET streams the full PDF: merged.pdf (main + PDF supplements) when present, else
// main.pdf. A Writable-backed mock lets the route's createReadStream(...).pipe(res)
// complete; headers are set synchronously before piping, so they're captured.
function makeStreamRes(): {
  res: NextApiResponse;
  captured: CapturedResponse;
  done: Promise<void>;
} {
  const captured: CapturedResponse = {
    statusCode: 0,
    body: undefined,
    headers: {},
  };
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  const writable = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  writable.on("finish", () => resolveDone());
  const res = Object.assign(writable, {
    status(code: number) {
      captured.statusCode = code;
      return res;
    },
    json(body: unknown) {
      captured.body = body;
      resolveDone();
      return res;
    },
    setHeader(name: string, value: string) {
      captured.headers[name] = value;
      return res;
    },
  }) as unknown as NextApiResponse;
  return { res, captured, done };
}

function getReq(doi: string): NextApiRequest {
  return {
    method: "GET",
    query: { doi },
    headers: {},
  } as unknown as NextApiRequest;
}

describe("GET /api/papers/[doi]/pdf", () => {
  const doi = "10.1371/journal.pone.0131517";

  function paperDir(): string {
    const dir = join(dataRoot, "papers", encodeDoi(doi));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  test("404 when neither main.pdf nor merged.pdf exists", async () => {
    const { default: handler } =
      await import("../src/pages/api/papers/[doi]/pdf");
    const { res, captured } = makeRes();
    await handler(getReq(doi), res);
    expect(captured.statusCode).toBe(404);
  });

  test("serves main.pdf when only main.pdf exists", async () => {
    const { default: handler } =
      await import("../src/pages/api/papers/[doi]/pdf");
    writeFileSync(join(paperDir(), "main.pdf"), Buffer.from("%PDF main\n"));
    const { res, captured, done } = makeStreamRes();
    await handler(getReq(doi), res);
    await done;
    expect(captured.headers["Content-Type"]).toBe("application/pdf");
    expect(captured.headers["Content-Length"]).toBe("10");
  });

  test("prefers merged.pdf over main.pdf when both exist", async () => {
    const { default: handler } =
      await import("../src/pages/api/papers/[doi]/pdf");
    const dir = paperDir();
    writeFileSync(join(dir, "main.pdf"), Buffer.from("%PDF main\n")); // 10 bytes
    writeFileSync(join(dir, "merged.pdf"), Buffer.from("%PDF merged supp\n")); // 17 bytes
    const { res, captured, done } = makeStreamRes();
    await handler(getReq(doi), res);
    await done;
    expect(captured.headers["Content-Length"]).toBe("17"); // merged.pdf, not main.pdf
  });
});
