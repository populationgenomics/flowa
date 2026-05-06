import type { NextApiRequest, NextApiResponse } from "next";
import { getDb, loadSnapshot, type WorkspaceKey } from "@/lib/triageDb";
import { getTriageDbPath } from "@/lib/demoConfig";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { variantId, category, version } = req.query;
  if (
    typeof variantId !== "string" ||
    typeof category !== "string" ||
    typeof version !== "string"
  ) {
    res.status(400).json({ error: "Invalid path parameters" });
    return;
  }

  const versionNum = Number.parseInt(version, 10);
  if (!Number.isFinite(versionNum) || versionNum < 0) {
    res.status(400).json({ error: "Invalid version" });
    return;
  }

  const key: WorkspaceKey = { variantId, category, version: versionNum };
  const db = getDb(getTriageDbPath());
  const snapshot = loadSnapshot(db, key);

  // ISO-stringify dates for the JSON wire shape; client deserialises.
  res.status(200).json({
    claims: snapshot.claims,
    comments: snapshot.comments,
    papers: snapshot.papers.map((p) => ({
      paperId: p.paperId,
      triageDoneAt: p.triageDoneAt.toISOString(),
      triageDoneBy: p.triageDoneBy,
    })),
  });
}
