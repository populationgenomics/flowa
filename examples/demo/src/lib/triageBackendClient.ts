/**
 * Browser-side `TriageBackend` implementation that fetches the demo's
 * existing `/api/triage/*` Next.js routes. The routes write to a local
 * SQLite DB; this module just shapes the requests + responses to satisfy
 * the `@flowajs/react-viewer` interface.
 */

import type {
  TriageBackend,
  TriageSnapshotPayload,
  TriageStateValue,
  WorkspaceKey,
} from "@flowajs/react-viewer";

interface SnapshotResponse {
  claims: { paperId: string; claimIndex: number; state: TriageStateValue }[];
  papers: { paperId: string; triageDoneAt: string; triageDoneBy: string }[];
  comments: { paperId: string; claimIndex: number; body: string }[];
}

async function postJson(path: string, body: unknown): Promise<void> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${path} → ${res.status}`);
  }
}

export function createTriageBackendClient(): TriageBackend {
  return {
    async load(key: WorkspaceKey): Promise<TriageSnapshotPayload> {
      // The existing snapshot route is keyed by (variantId, category, version)
      // — the three load-bearing fields the workspace key always carries.
      const variantId = String(key.variantId ?? "");
      const category = String(key.category ?? "");
      const version = String(key.version ?? 0);
      const url = `/api/triage/snapshot/${encodeURIComponent(variantId)}/${encodeURIComponent(category)}/${encodeURIComponent(version)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url} → ${res.status}`);
      const data = (await res.json()) as SnapshotResponse;
      return {
        claims: data.claims,
        papers: data.papers.map((p) => ({
          paperId: p.paperId,
          triageDoneAt: new Date(p.triageDoneAt),
          triageDoneBy: p.triageDoneBy,
        })),
        comments: data.comments,
      };
    },

    async setClaimState(key, paperId, claimIndex, state) {
      await postJson("/api/triage/claim", {
        workspaceKey: key,
        paperId,
        claimIndex,
        state,
      });
    },

    async setClaimComment(key, paperId, claimIndex, body) {
      await postJson("/api/triage/comment", {
        workspaceKey: key,
        paperId,
        claimIndex,
        body,
      });
    },

    async setPaperDone(key, paperId, done, user) {
      await postJson("/api/triage/paper-done", {
        workspaceKey: key,
        paperId,
        done,
        user,
      });
    },
  };
}
