/**
 * GET /api/runs/latest?variantId=X
 *
 * Filesystem-backed latest-run discovery. The literature page calls this
 * on mount to decide whether to start polling. Returns 404 when the
 * variant has no run history at all (a brand-new variant submitted
 * seconds ago could see this if demo-gateway hasn't created the run dir
 * yet, but practically the gateway creates the dir synchronously inside
 * `start` before the HTTP response returns, so this race is very narrow).
 *
 * Filesystem-backed deliberately: a real deployment indexes runs in a
 * database, but the demo's working set is small enough that scanning a
 * single variant dir is faster than maintaining a write path that has
 * to stay in sync. Also survives gateway restarts (in-memory state in
 * demo-gateway's `RunManager._records` wipes on restart, the filesystem
 * doesn't).
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { findLatestRun } from "@/lib/runs";
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

  const latest = await findLatestRun(variantId);
  if (latest === null) {
    res.status(404).json({ error: `no runs for variant ${variantId}` });
    return;
  }
  res.status(200).json(latest);
}
