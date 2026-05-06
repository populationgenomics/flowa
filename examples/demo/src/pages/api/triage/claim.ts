import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";
import {
  getDb,
  setClaimState,
  type WorkspaceKey,
  type TriageStateValue,
} from "@/lib/triageDb";
import { getTriageDbPath } from "@/lib/demoConfig";

const Body = z.object({
  workspaceKey: z.record(z.string(), z.union([z.string(), z.number()])),
  paperId: z.string(),
  claimIndex: z.number().int().nonnegative(),
  state: z.enum(["UNREVIEWED", "ACCEPTED", "REJECTED"]),
});

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "Invalid body", details: parsed.error.issues });
    return;
  }

  const db = getDb(getTriageDbPath());
  setClaimState(
    db,
    parsed.data.workspaceKey as WorkspaceKey,
    parsed.data.paperId,
    parsed.data.claimIndex,
    parsed.data.state as TriageStateValue,
  );

  res.status(204).end();
}
