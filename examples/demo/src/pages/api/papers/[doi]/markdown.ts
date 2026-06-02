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

  // The route param arrives URL-decoded; re-encode via RFC 3986 strict
  // to land on the on-disk directory name. markdown.md is the assembled,
  // consumer-facing Markdown (source.md + converted supplements) the
  // viewer renders and markdown_anchor offsets index into.
  const path = join(getDemoDataDir(), "papers", encodeDoi(doi), "markdown.md");
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
