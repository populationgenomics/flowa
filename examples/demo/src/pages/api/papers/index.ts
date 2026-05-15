/**
 * GET /api/papers?variantId=X
 *
 * Lists papers for one variant with derived statuses (extracted /
 * downloaded / needs_manual) plus `aggregateExists` + `categories` so
 * the literature page can decide whether to render "Open analysis"
 * buttons. Mirrors what a real consumer would derive from object
 * storage, just over a local filesystem.
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { listPapersForVariant } from "@/lib/papers";
import { isValidVariantId } from "@/lib/variantId";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const variantIdRaw = req.query.variantId;
  const variantId = Array.isArray(variantIdRaw)
    ? variantIdRaw[0]
    : variantIdRaw;
  if (typeof variantId !== "string" || !isValidVariantId(variantId)) {
    res.status(400).json({ error: "Invalid variantId" });
    return;
  }

  const result = await listPapersForVariant(variantId);
  res.status(200).json(result);
}
