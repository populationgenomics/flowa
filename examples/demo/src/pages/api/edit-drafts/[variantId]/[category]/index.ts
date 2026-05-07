import type { NextApiRequest, NextApiResponse } from "next";
import { listVersions } from "@/lib/aggregate";

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
  const versions = await listVersions(variantId, category);
  res.status(200).json({ versions });
}
