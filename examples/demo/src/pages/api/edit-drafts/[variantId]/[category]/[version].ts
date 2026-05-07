import type { NextApiRequest, NextApiResponse } from "next";
import { loadAggregate, loadEditDraft } from "@/lib/aggregate";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
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
  const loaded =
    versionNum === 0
      ? await loadAggregate(variantId, category)
      : await loadEditDraft(variantId, category, versionNum);
  if (!loaded) {
    res.status(404).json({ error: "Version not found" });
    return;
  }
  res.status(200).json({
    artifact: loaded.artifact,
    paperIdMapping: loaded.paperIdMapping,
    artifactText: loaded.artifactText,
  });
}
