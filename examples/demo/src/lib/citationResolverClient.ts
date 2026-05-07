/**
 * Browser-side `CitationResolver` that POSTs to demo-gateway's
 * `/resolve-citations` endpoint. Direct-talk on `:7702` (no Next.js
 * proxy) — mirrors the same direct-talk pattern the demo uses for run
 * triggers. demo-gateway calls `flowa.resolve.resolve_citations` in-process.
 */

import type {
  CitationQuery,
  CitationResolver,
  ResolvedCitations,
} from "@flowajs/react-viewer";

export interface CitationResolverConfig {
  /** Base URL for demo-gateway; e.g. "http://localhost:7702". */
  gatewayBase: string;
}

export function createCitationResolver(
  config: CitationResolverConfig,
): CitationResolver {
  return async (citations: CitationQuery[]): Promise<ResolvedCitations> => {
    const res = await fetch(`${config.gatewayBase}/resolve-citations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ citations }),
    });
    if (!res.ok) {
      throw new Error(
        `POST ${config.gatewayBase}/resolve-citations → ${res.status}`,
      );
    }
    return (await res.json()) as ResolvedCitations;
  };
}
