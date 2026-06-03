import type { NextApiRequest, NextApiResponse } from "next";
import { existsSync, createReadStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import formidable from "formidable";
import type { Fields, File as FormidableFile, Files } from "formidable";
import { encodeDoi } from "@flowajs/react-viewer";
import { getDemoDataDir } from "@/lib/demoConfig";
import { invalidateMainPdfChange } from "@/lib/paperInvalidation";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

// formidable streams the body directly off req; Next must not parse it.
export const config = {
  api: { bodyParser: false },
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method === "GET") return handleGet(req, res);
  if (req.method === "POST") return handlePost(req, res);
  res.setHeader("Allow", "GET, POST");
  res.status(405).json({ error: "Method not allowed" });
}

function paperDir(doi: string): string {
  // The route param arrives URL-decoded; re-encode via RFC 3986 strict to
  // land on the on-disk directory name.
  return join(getDemoDataDir(), "papers", encodeDoi(doi));
}

/** The full PDF the viewer renders: merged.pdf (main + PDF supplements) if present,
 *  else main.pdf — mirrors flowa.storage.full_pdf_url. */
function fullPdfPath(doi: string): string {
  const merged = join(paperDir(doi), "merged.pdf");
  return existsSync(merged) ? merged : join(paperDir(doi), "main.pdf");
}

/** The raw main-paper PDF an upload writes. */
function mainPdfPath(doi: string): string {
  return join(paperDir(doi), "main.pdf");
}

function firstField(fields: Fields, name: string): string | undefined {
  const v = fields[name];
  if (Array.isArray(v)) return v[0];
  return typeof v === "string" ? v : undefined;
}

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const { doi } = req.query;
  if (typeof doi !== "string") {
    res.status(400).json({ error: "Invalid path parameters" });
    return;
  }
  const path = fullPdfPath(doi);
  if (!existsSync(path)) {
    // No main.pdf yet (e.g. uploaded but not converted, or never provided).
    res.status(404).json({ error: "PDF not found" });
    return;
  }
  const s = await stat(path);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Length", String(s.size));
  res.setHeader("Cache-Control", "private, max-age=300");
  createReadStream(path).pipe(res);
}

async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  const { doi } = req.query;
  if (typeof doi !== "string") {
    res.status(400).json({ error: "Invalid path parameters" });
    return;
  }

  const destPath = mainPdfPath(doi);
  await mkdir(dirname(destPath), { recursive: true });

  const form = formidable({
    maxFileSize: MAX_UPLOAD_BYTES,
    multiples: false,
    // Park temp uploads inside the destination dir so the final rename
    // stays within one filesystem (cross-device rename would fall back
    // to copy+unlink).
    uploadDir: dirname(destPath),
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

  // Accept any single file under any field name — the literature page
  // posts the dropped File under `file`, but other clients (curl, etc.)
  // may name it differently; coercing to the first attached file is
  // friendlier than enforcing a field name the curator doesn't see.
  const all = Object.values(files).flatMap<FormidableFile>((f) =>
    f ? (Array.isArray(f) ? f : [f]) : [],
  );
  const file = all[0];
  if (!file) {
    res.status(400).json({ error: "No file attached" });
    return;
  }

  try {
    await rename(file.filepath, destPath);
  } catch {
    // If rename fails (e.g. cross-device), at least clean up the tmp file.
    await unlink(file.filepath).catch(() => undefined);
    res.status(500).json({ error: "Failed to store PDF" });
    return;
  }

  // A new main PDF makes every derived artifact (main.md, merged.pdf, pdf_index,
  // merged.md) stale; the curator's next Re-analyze regenerates them. No-op for
  // a brand-new paper that has no derived data yet.
  await invalidateMainPdfChange(
    getDemoDataDir(),
    doi,
    firstField(fields, "variantId"),
  );

  const s = await stat(destPath);
  res.status(200).json({ ok: true, doi, size: s.size });
}
