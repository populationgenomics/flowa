import type { NextApiRequest, NextApiResponse } from "next";
import { existsSync } from "node:fs";
import { mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import formidable from "formidable";
import type { Fields, File as FormidableFile, Files } from "formidable";
import { encodeDoi } from "@flowajs/react-viewer";
import { getDemoDataDir } from "@/lib/demoConfig";
import {
  invalidatePaperDerivedData,
  invalidatePdfSupplementChange,
} from "@/lib/paperInvalidation";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

// xlsx/docx are Office Open XML — zip archives whose first bytes are the
// local-file-header signature. Legacy .xls is an OLE2 compound document. PDF
// supplements start with "%PDF". We check magic bytes so a mis-renamed or
// corrupt upload is rejected here rather than mishandled later by the pipeline
// (office supplements go through markitdown in assemble; PDF supplements are
// transcribed + merged in convert).
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46]); // "%PDF"

// formidable streams the body directly off req; Next must not parse it.
export const config = {
  api: { bodyParser: false },
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const { doi } = req.query;
  if (typeof doi !== "string") {
    res.status(400).json({ error: "Invalid path parameters" });
    return;
  }
  if (req.method === "GET") return handleGet(doi, res);
  if (req.method === "POST") return handlePost(req, res, doi);
  if (req.method === "DELETE") return handleDelete(req, res, doi);
  res.setHeader("Allow", "GET, POST, DELETE");
  res.status(405).json({ error: "Method not allowed" });
}

function paperDir(doi: string): string {
  // The route param arrives URL-decoded; re-encode via RFC 3986 strict to
  // land on the on-disk directory name.
  return join(getDemoDataDir(), "papers", encodeDoi(doi));
}

function supplementsDir(doi: string): string {
  return join(paperDir(doi), "supplements");
}

/** Mirror of flowa.download._sanitize_supplement_filename. */
function sanitizeBasename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
}

/**
 * Next `ord` prefix = max existing prefix + 1 (not a raw count): a deleted
 * supplement leaves a gap, and reusing the count would collide with a
 * surviving file. A re-added supplement sorts last, which is correct — it
 * is the newest in ingestion order.
 */
function nextOrd(filenames: string[]): number {
  let max = -1;
  for (const f of filenames) {
    const m = /^(\d{3})_/.exec(f);
    if (m) max = Math.max(max, Number.parseInt(m[1]!, 10));
  }
  return max + 1;
}

type Verdict = { ok: true } | { ok: false; error: string };

function validateSupplement(originalFilename: string, header: Buffer): Verdict {
  const dot = originalFilename.lastIndexOf(".");
  const ext = dot >= 0 ? originalFilename.slice(dot).toLowerCase() : "";
  if (ext === ".doc") {
    return {
      ok: false,
      error: "Legacy .doc is not supported — save as .docx and re-upload.",
    };
  }
  if (ext === ".xlsx" || ext === ".docx") {
    if (!header.subarray(0, 4).equals(ZIP_MAGIC)) {
      return {
        ok: false,
        error: `File content is not a valid ${ext} (Office Open XML / zip) document.`,
      };
    }
    return { ok: true };
  }
  if (ext === ".xls") {
    if (!header.subarray(0, 8).equals(OLE_MAGIC)) {
      return {
        ok: false,
        error: "File content is not a valid .xls (legacy Excel) document.",
      };
    }
    return { ok: true };
  }
  if (ext === ".pdf") {
    if (!header.subarray(0, 4).equals(PDF_MAGIC)) {
      return { ok: false, error: "File content is not a valid PDF document." };
    }
    return { ok: true };
  }
  return {
    ok: false,
    error: "Only .xlsx, .xls, .docx, and .pdf supplements are supported.",
  };
}

async function readHeader(path: string, n: number): Promise<Buffer> {
  const fd = await open(path, "r");
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fd.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fd.close();
  }
}

function firstFile(files: Files): FormidableFile | undefined {
  // Accept any single file under any field name — friendlier than enforcing
  // a field name the curator doesn't see (matches pdf.ts).
  return Object.values(files).flatMap<FormidableFile>((f) =>
    f ? (Array.isArray(f) ? f : [f]) : [],
  )[0];
}

function firstField(fields: Fields, name: string): string | undefined {
  const v = fields[name];
  if (Array.isArray(v)) return v[0];
  return typeof v === "string" ? v : undefined;
}

function firstQuery(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function handleGet(doi: string, res: NextApiResponse) {
  const dir = supplementsDir(doi);
  if (!existsSync(dir)) {
    res.status(200).json({ supplements: [] });
    return;
  }
  // Hide the convert-written `*.pdf.md` transcription sidecars — they're derived
  // artifacts, not user-managed supplements.
  const names = (await readdir(dir))
    .sort()
    .filter((n) => !n.endsWith(".pdf.md"));
  const supplements: Array<{ filename: string; size: number }> = [];
  for (const filename of names) {
    const s = await stat(join(dir, filename));
    if (s.isFile()) supplements.push({ filename, size: s.size });
  }
  res.status(200).json({ supplements });
}

async function handlePost(
  req: NextApiRequest,
  res: NextApiResponse,
  doi: string,
) {
  // Supplements attach to an existing paper; refuse to litter the tree with
  // an orphan supplements/ dir for a bogus DOI.
  if (!existsSync(paperDir(doi))) {
    res.status(404).json({ error: "Paper not found" });
    return;
  }

  const dir = supplementsDir(doi);
  await mkdir(dir, { recursive: true });

  const form = formidable({
    maxFileSize: MAX_UPLOAD_BYTES,
    multiples: false,
    // Park the temp upload inside the destination dir so the final rename
    // stays within one filesystem.
    uploadDir: dir,
    keepExtensions: false,
  });

  let fields: Fields;
  let files: Files;
  try {
    [fields, files] = await new Promise<[Fields, Files]>((resolve, reject) => {
      form.parse(req, (err, parsedFields, parsedFiles) => {
        if (err) reject(err);
        else resolve([parsedFields, parsedFiles]);
      });
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "upload failed";
    res.status(400).json({ error: msg });
    return;
  }

  const file = firstFile(files);
  if (!file) {
    res.status(400).json({ error: "No file attached" });
    return;
  }

  const original = file.originalFilename ?? "supplement";
  const header = await readHeader(file.filepath, OLE_MAGIC.length);
  const verdict = validateSupplement(original, header);
  if (!verdict.ok) {
    await unlink(file.filepath).catch(() => undefined);
    res.status(400).json({ error: verdict.error });
    return;
  }

  // The just-parked temp file carries a random formidable name that doesn't
  // match the NNN_ prefix pattern, so it doesn't perturb the ord count.
  const ord = nextOrd(await readdir(dir));
  const finalName = `${String(ord).padStart(3, "0")}_${sanitizeBasename(original)}`;
  const destPath = join(dir, finalName);
  try {
    await rename(file.filepath, destPath);
  } catch {
    await unlink(file.filepath).catch(() => undefined);
    res.status(500).json({ error: "Failed to store supplement" });
    return;
  }

  // The supplement set changed: invalidate the derived data the curator's next
  // Re-analyze must regenerate. An office supplement only restales merged.md
  // (cheap re-assemble, transcriptions survive); a PDF supplement also restales
  // merged.pdf + the index (convert re-transcribes just the new file, re-merges,
  // re-indexes).
  const isPdf = original.toLowerCase().endsWith(".pdf");
  const invalidate = isPdf
    ? invalidatePdfSupplementChange
    : invalidatePaperDerivedData;
  await invalidate(getDemoDataDir(), doi, firstField(fields, "variantId"));

  const s = await stat(destPath);
  res.status(200).json({ ok: true, doi, filename: finalName, size: s.size });
}

async function handleDelete(
  req: NextApiRequest,
  res: NextApiResponse,
  doi: string,
) {
  const { filename } = req.query;
  // Guard against path traversal: a supplement basename is exactly the
  // sanitised char set, with no separators and no `..`.
  if (
    typeof filename !== "string" ||
    filename.includes("..") ||
    !/^[A-Za-z0-9._-]+$/.test(filename)
  ) {
    res.status(400).json({ error: "Invalid filename" });
    return;
  }
  const path = join(supplementsDir(doi), filename);
  if (!existsSync(path)) {
    res.status(404).json({ error: "Supplement not found" });
    return;
  }
  await unlink(path);

  const isPdf = filename.toLowerCase().endsWith(".pdf");
  if (isPdf) {
    // Drop the convert-written transcription sidecar alongside the raw PDF.
    await unlink(join(supplementsDir(doi), `${filename}.md`)).catch(
      () => undefined,
    );
  }
  const invalidate = isPdf
    ? invalidatePdfSupplementChange
    : invalidatePaperDerivedData;
  await invalidate(getDemoDataDir(), doi, firstQuery(req.query.variantId));

  res.status(200).json({ ok: true, doi, filename });
}
