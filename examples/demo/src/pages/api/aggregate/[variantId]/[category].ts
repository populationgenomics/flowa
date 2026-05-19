import type { NextApiRequest, NextApiResponse } from "next";
import { loadAggregate } from "@/lib/aggregate";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const { variantId, category } = req.query;
  if (typeof variantId !== "string" || typeof category !== "string") {
    res.status(400).json({ error: "Invalid path parameters" });
    return;
  }
  const loaded = await loadAggregate(variantId, category);
  if (!loaded) {
    res.status(404).json({ error: "aggregation.json or category not found" });
    return;
  }
  res.status(200).json({
    artifact: loaded.artifact,
    paperIdMapping: loaded.paperIdMapping,
    artifactText: loaded.artifactText,
  });
}
