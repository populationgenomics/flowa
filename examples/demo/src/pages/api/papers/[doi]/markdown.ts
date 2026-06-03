import type { NextApiRequest, NextApiResponse } from "next";
import { existsSync, createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { encodeDoi } from "@flowajs/react-viewer";
import { getDemoDataDir } from "@/lib/demoConfig";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { doi } = req.query;
  if (typeof doi !== "string") {
    res.status(400).json({ error: "Invalid path parameters" });
    return;
  }

  // The route param arrives URL-decoded; re-encode via RFC 3986 strict to land
  // on the on-disk directory name. The assembled, consumer-facing Markdown is
  // merged.md (main.md + PDF-supplement transcriptions + converted office
  // supplements) when the paper has supplements, else main.md — mirroring
  // flowa.storage.full_md_url. markdown_anchor offsets index into it.
  const dir = join(getDemoDataDir(), "papers", encodeDoi(doi));
  const merged = join(dir, "merged.md");
  const path = existsSync(merged) ? merged : join(dir, "main.md");
  if (!existsSync(path)) {
    res.status(404).json({ error: "Markdown not found" });
    return;
  }
  const s = await stat(path);
  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  res.setHeader("Content-Length", String(s.size));
  res.setHeader("Cache-Control", "private, max-age=300");
  createReadStream(path).pipe(res);
}
