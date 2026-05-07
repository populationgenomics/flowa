import type { NextApiRequest, NextApiResponse } from "next";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
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
  // The route param arrives URL-decoded by Next, so re-encode to land on
  // the on-disk directory name (which uses RFC 3986 strict encoding).
  const encoded = encodeDoi(doi);
  const path = join(getDemoDataDir(), "papers", encoded, "source.pdf");
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
