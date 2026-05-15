/**
 * POST /api/runs      — trigger a pipeline run from `/` or Re-analyze.
 * GET  /api/runs?page=N — paginated runs history for the `/` page.
 *
 * The browser only ever submits `{ gene, hgvs_c }`. Mirrors what
 * curation-service does at the assessment layer: variant_id is derived
 * on the trusted server, not carried in the body. The derivation is
 * deterministic, so a Re-analyze for the same gene + hgvs_c produces
 * the same variant_id and lands on the same `assessments/` dir.
 *
 * The actual pipeline launch lives in demo-gateway (Python); this
 * handler forwards a body in demo-gateway's snake_case wire shape and
 * surfaces the gateway's status code unchanged (429 from concurrency
 * cap, 409 from a duplicate in-flight run, 5xx from the pipeline).
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { deriveVariantId } from "@/lib/variantId";
import { getDemoGatewayUrl } from "@/lib/demoConfig";
import { scanRunsHistory, DEFAULT_RUNS_PAGE_SIZE } from "@/lib/runs";

interface PostBody {
  gene?: unknown;
  hgvs_c?: unknown;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method === "POST") return handlePost(req, res);
  if (req.method === "GET") return handleGet(req, res);
  res.setHeader("Allow", "GET, POST");
  res.status(405).json({ error: "Method not allowed" });
}

async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  const body = (req.body ?? {}) as PostBody;
  if (!isNonEmptyString(body.gene) || !isNonEmptyString(body.hgvs_c)) {
    res
      .status(400)
      .json({ error: "Both gene and hgvs_c are required (non-empty strings)" });
    return;
  }

  const gene = body.gene;
  const hgvs_c = body.hgvs_c;
  const variant_id = deriveVariantId(gene, hgvs_c);

  const gatewayResponse = await fetch(`${getDemoGatewayUrl()}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ variant_id, gene, hgvs_c }),
  });

  // Surface the gateway's status code so the page can distinguish 409
  // (run already in flight) from 429 (concurrency cap) from 5xx.
  const text = await gatewayResponse.text();
  res.status(gatewayResponse.status);
  res.setHeader("Content-Type", "application/json");
  res.send(text);
}

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const pageRaw = req.query.page;
  const pageParam = Array.isArray(pageRaw) ? pageRaw[0] : pageRaw;
  const page = pageParam ? Number.parseInt(pageParam, 10) : 1;
  if (!Number.isFinite(page) || page < 1) {
    res.status(400).json({ error: "Invalid page" });
    return;
  }

  const result = await scanRunsHistory({
    page,
    pageSize: DEFAULT_RUNS_PAGE_SIZE,
  });
  res.status(200).json(result);
}
