import type { NextApiRequest, NextApiResponse } from "next";
import { existsSync, createReadStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import formidable from "formidable";
import type { Fields, File as FormidableFile, Files } from "formidable";
import { encodeDoi } from "@flowajs/react-viewer";
import { getDemoDataDir } from "@/lib/demoConfig";

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

function resolvePdfPath(doi: string): string {
  // The route param arrives URL-decoded; re-encode via RFC 3986 strict
  // to land on the on-disk directory name.
  const encoded = encodeDoi(doi);
  return join(getDemoDataDir(), "papers", encoded, "source.pdf");
}

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const { doi } = req.query;
  if (typeof doi !== "string") {
    res.status(400).json({ error: "Invalid path parameters" });
    return;
  }
  const path = resolvePdfPath(doi);
  if (!existsSync(path)) {
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

  const destPath = resolvePdfPath(doi);
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

  let files: Files;
  try {
    [, files] = await new Promise<[Fields, Files]>((resolve, reject) => {
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

  const s = await stat(destPath);
  res.status(200).json({ ok: true, doi, size: s.size });
}
