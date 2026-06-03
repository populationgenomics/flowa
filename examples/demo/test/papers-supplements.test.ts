/**
 * Tests for `GET/POST/DELETE /api/papers/[doi]/supplements`.
 *
 * formidable's multipart parser is exercised by its own suite — we mock it
 * and assert what the route does with the parsed result: validate the
 * extension + magic bytes, store under the `{ord:03d}_{sanitised}` name,
 * invalidate the paper's derived data, and reject bad input.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NextApiRequest, NextApiResponse } from "next";
import { encodeDoi } from "@flowajs/react-viewer";

const DOI = "10.1038/s41598-022-25914-8";
const VARIANT = "NM_000152_5-c_1935C_A";

// Office Open XML (xlsx/docx) starts with the zip local-file-header magic.
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46]); // "%PDF"

let dataRoot: string;
let originalDemoDataDir: string | undefined;
let originalCwd: string;

type ParseCallback = (err: unknown, fields: unknown, files: unknown) => void;
const mockParseImpl = vi.fn<(req: unknown, callback: ParseCallback) => void>();

vi.mock("formidable", () => {
  const factory = vi.fn(() => ({ parse: mockParseImpl }));
  return { default: factory };
});

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "flowa-demo-supplements-"));
  originalDemoDataDir = process.env.DEMO_DATA_DIR;
  process.env.DEMO_DATA_DIR = dataRoot;
  originalCwd = process.cwd();
  process.chdir(dataRoot);
  mockParseImpl.mockReset();
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalDemoDataDir === undefined) delete process.env.DEMO_DATA_DIR;
  else process.env.DEMO_DATA_DIR = originalDemoDataDir;
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

async function importHandler() {
  const mod = await import("../src/pages/api/papers/[doi]/supplements");
  return mod.default;
}

/** Create papers/{doi}/ (POST refuses an unknown paper) and return its dir. */
function makePaperDir(doi = DOI): string {
  const dir = join(dataRoot, "papers", encodeDoi(doi));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Stage a temp upload inside supplements/ and arrange the mocked parser to
 * hand it back, mirroring formidable's `uploadDir` behaviour. */
function arrangeUpload(opts: {
  originalFilename: string;
  bytes: Buffer;
  variantId?: string;
  paperDir: string;
}): void {
  const supplementsDir = join(opts.paperDir, "supplements");
  mkdirSync(supplementsDir, { recursive: true });
  const tmpFile = join(supplementsDir, "staged_upload.bin");
  writeFileSync(tmpFile, opts.bytes);
  const fields = opts.variantId ? { variantId: [opts.variantId] } : {};
  mockParseImpl.mockImplementation((_req, callback) => {
    callback(null, fields, {
      file: [{ filepath: tmpFile, originalFilename: opts.originalFilename }],
    });
  });
}

function req(
  method: string,
  query: Record<string, string> = {},
): NextApiRequest {
  return {
    method,
    query: { doi: DOI, ...query },
    headers: {},
  } as unknown as NextApiRequest;
}

describe("GET /api/papers/[doi]/supplements", () => {
  test("returns an empty list when no supplements dir exists", async () => {
    const handler = await importHandler();
    const { res, captured } = makeRes();
    await handler(req("GET"), res);
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toEqual({ supplements: [] });
  });

  test("lists stored supplements with sizes, sorted", async () => {
    const dir = join(makePaperDir(), "supplements");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "001_b.docx"), Buffer.from("bb"));
    writeFileSync(join(dir, "000_a.xlsx"), Buffer.from("aaaa"));
    const handler = await importHandler();
    const { res, captured } = makeRes();
    await handler(req("GET"), res);
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toEqual({
      supplements: [
        { filename: "000_a.xlsx", size: 4 },
        { filename: "001_b.docx", size: 2 },
      ],
    });
  });

  test("lists PDF supplements but hides their .pdf.md transcription sidecars", async () => {
    const dir = join(makePaperDir(), "supplements");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "000_fig.pdf"), Buffer.from("%PDF"));
    writeFileSync(join(dir, "000_fig.pdf.md"), Buffer.from("transcript"));
    const handler = await importHandler();
    const { res, captured } = makeRes();
    await handler(req("GET"), res);
    expect(captured.body).toEqual({
      supplements: [{ filename: "000_fig.pdf", size: 4 }],
    });
  });
});

describe("POST /api/papers/[doi]/supplements", () => {
  test("404 when the paper does not exist", async () => {
    // The route checks the paper dir before parsing the form, so no upload
    // needs arranging — and we deliberately do not create papers/{doi}/.
    const handler = await importHandler();
    const { res, captured } = makeRes();
    await handler(req("POST"), res);
    expect(captured.statusCode).toBe(404);
  });

  test("stores a valid .docx under the 000_ prefix and sanitises the name", async () => {
    const paperDir = makePaperDir();
    const bytes = Buffer.concat([ZIP_MAGIC, Buffer.from("docx-body")]);
    arrangeUpload({ originalFilename: "Table S1.docx", bytes, paperDir });
    const handler = await importHandler();
    const { res, captured } = makeRes();
    await handler(req("POST"), res);
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toMatchObject({
      ok: true,
      doi: DOI,
      filename: "000_Table_S1.docx",
      size: bytes.length,
    });
    expect(existsSync(join(paperDir, "supplements", "000_Table_S1.docx"))).toBe(
      true,
    );
  });

  test("assigns ord = max existing prefix + 1 (gap-safe after deletes)", async () => {
    const paperDir = makePaperDir();
    const supplementsDir = join(paperDir, "supplements");
    mkdirSync(supplementsDir, { recursive: true });
    writeFileSync(join(supplementsDir, "000_a.docx"), Buffer.from("a"));
    writeFileSync(join(supplementsDir, "002_c.docx"), Buffer.from("c"));
    arrangeUpload({
      originalFilename: "new.docx",
      bytes: Buffer.concat([ZIP_MAGIC, Buffer.from("z")]),
      paperDir,
    });
    const handler = await importHandler();
    const { res, captured } = makeRes();
    await handler(req("POST"), res);
    expect(captured.body).toMatchObject({ filename: "003_new.docx" });
  });

  test("rejects legacy .doc with a save-as-.docx message", async () => {
    const paperDir = makePaperDir();
    arrangeUpload({
      originalFilename: "old.doc",
      bytes: Buffer.from("anything"),
      paperDir,
    });
    const handler = await importHandler();
    const { res, captured } = makeRes();
    await handler(req("POST"), res);
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toMatchObject({
      error: expect.stringContaining(".docx"),
    });
  });

  test("rejects a .xlsx whose content is not a zip (magic-byte mismatch)", async () => {
    const paperDir = makePaperDir();
    arrangeUpload({
      originalFilename: "data.xlsx",
      bytes: Buffer.from("this is not a zip archive"),
      paperDir,
    });
    const handler = await importHandler();
    const { res, captured } = makeRes();
    await handler(req("POST"), res);
    expect(captured.statusCode).toBe(400);
  });

  test("stores a valid .pdf supplement under the 000_ prefix", async () => {
    const paperDir = makePaperDir();
    const bytes = Buffer.concat([PDF_MAGIC, Buffer.from("-1.7 body")]);
    arrangeUpload({ originalFilename: "Figure S1.pdf", bytes, paperDir });
    const handler = await importHandler();
    const { res, captured } = makeRes();
    await handler(req("POST"), res);
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toMatchObject({ filename: "000_Figure_S1.pdf" });
    expect(existsSync(join(paperDir, "supplements", "000_Figure_S1.pdf"))).toBe(
      true,
    );
  });

  test("rejects a .pdf whose content is not a PDF (magic-byte mismatch)", async () => {
    const paperDir = makePaperDir();
    arrangeUpload({
      originalFilename: "fig.pdf",
      bytes: Buffer.from("not a pdf"),
      paperDir,
    });
    const handler = await importHandler();
    const { res, captured } = makeRes();
    await handler(req("POST"), res);
    expect(captured.statusCode).toBe(400);
  });

  test("a PDF supplement invalidates merged.pdf + index + merged.md (not just merged.md)", async () => {
    const paperDir = makePaperDir();
    writeFileSync(join(paperDir, "main.md"), "transcription");
    writeFileSync(join(paperDir, "merged.pdf"), "merged");
    writeFileSync(join(paperDir, "pdf_index.pkl.zst"), "index");
    writeFileSync(join(paperDir, "merged.md"), "stale");

    arrangeUpload({
      originalFilename: "s.pdf",
      bytes: Buffer.concat([PDF_MAGIC, Buffer.from(" body")]),
      variantId: VARIANT,
      paperDir,
    });
    const handler = await importHandler();
    const { res, captured } = makeRes();
    await handler(req("POST"), res);

    expect(captured.statusCode).toBe(200);
    expect(existsSync(join(paperDir, "merged.pdf"))).toBe(false);
    expect(existsSync(join(paperDir, "pdf_index.pkl.zst"))).toBe(false);
    expect(existsSync(join(paperDir, "merged.md"))).toBe(false);
    expect(existsSync(join(paperDir, "main.md"))).toBe(true); // transcription survives
  });

  test("invalidates merged.md + the variant's extractions, keeps aggregation", async () => {
    const paperDir = makePaperDir();
    const encoded = encodeDoi(DOI);
    writeFileSync(join(paperDir, "merged.md"), "stale");
    const assessmentDir = join(dataRoot, "assessments", VARIANT);
    const extractionsDir = join(assessmentDir, "extractions");
    mkdirSync(extractionsDir, { recursive: true });
    writeFileSync(join(extractionsDir, `${encoded}.json`), "{}");
    writeFileSync(join(extractionsDir, `${encoded}_raw.json`), "{}");
    writeFileSync(join(assessmentDir, "aggregation.json"), "{}");

    arrangeUpload({
      originalFilename: "s.docx",
      bytes: Buffer.concat([ZIP_MAGIC, Buffer.from("body")]),
      variantId: VARIANT,
      paperDir,
    });
    const handler = await importHandler();
    const { res, captured } = makeRes();
    await handler(req("POST"), res);

    expect(captured.statusCode).toBe(200);
    expect(existsSync(join(paperDir, "merged.md"))).toBe(false);
    expect(existsSync(join(extractionsDir, `${encoded}.json`))).toBe(false);
    expect(existsSync(join(extractionsDir, `${encoded}_raw.json`))).toBe(false);
    expect(existsSync(join(assessmentDir, "aggregation.json"))).toBe(true);
  });
});

describe("DELETE /api/papers/[doi]/supplements", () => {
  test("removes the supplement and invalidates derived data", async () => {
    const paperDir = makePaperDir();
    const supplementsDir = join(paperDir, "supplements");
    mkdirSync(supplementsDir, { recursive: true });
    writeFileSync(join(supplementsDir, "000_a.docx"), Buffer.from("a"));
    writeFileSync(join(paperDir, "merged.md"), "stale");

    const handler = await importHandler();
    const { res, captured } = makeRes();
    await handler(
      req("DELETE", { filename: "000_a.docx", variantId: VARIANT }),
      res,
    );

    expect(captured.statusCode).toBe(200);
    expect(existsSync(join(supplementsDir, "000_a.docx"))).toBe(false);
    expect(existsSync(join(paperDir, "merged.md"))).toBe(false);
  });

  test("deleting a .pdf supplement also removes its .pdf.md sidecar", async () => {
    const paperDir = makePaperDir();
    const supplementsDir = join(paperDir, "supplements");
    mkdirSync(supplementsDir, { recursive: true });
    writeFileSync(join(supplementsDir, "000_fig.pdf"), Buffer.from("%PDF"));
    writeFileSync(
      join(supplementsDir, "000_fig.pdf.md"),
      Buffer.from("transcript"),
    );

    const handler = await importHandler();
    const { res, captured } = makeRes();
    await handler(
      req("DELETE", { filename: "000_fig.pdf", variantId: VARIANT }),
      res,
    );

    expect(captured.statusCode).toBe(200);
    expect(existsSync(join(supplementsDir, "000_fig.pdf"))).toBe(false);
    expect(existsSync(join(supplementsDir, "000_fig.pdf.md"))).toBe(false);
  });

  test("400 on a traversal filename", async () => {
    const handler = await importHandler();
    const { res, captured } = makeRes();
    await handler(req("DELETE", { filename: "../../etc/passwd" }), res);
    expect(captured.statusCode).toBe(400);
  });

  test("404 when the supplement is absent", async () => {
    makePaperDir();
    const handler = await importHandler();
    const { res, captured } = makeRes();
    await handler(req("DELETE", { filename: "999_missing.docx" }), res);
    expect(captured.statusCode).toBe(404);
  });
});

describe("supplements route method guard", () => {
  test("rejects unsupported methods with 405", async () => {
    const handler = await importHandler();
    const { res, captured } = makeRes();
    await handler(req("PATCH"), res);
    expect(captured.statusCode).toBe(405);
  });
});
