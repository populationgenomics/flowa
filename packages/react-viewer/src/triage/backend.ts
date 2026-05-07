/**
 * Triage persistence interface. The shell calls these methods through
 * whatever implementation the consumer wires up; the demo's impl is a thin
 * fetch wrapper over its `/api/triage/*` Next.js routes (which write to a
 * local SQLite DB), and a deployment-style impl typically wraps an
 * authenticated tRPC router writing to the deployment's primary database.
 *
 * Optimistic updates with revert-on-error are owned by the Zustand store
 * inside `@flowajs/react-viewer`, not by the backend. The backend is purely
 * persistence + load.
 */

import type { TriageStateValue, WorkspaceKey } from "./types";

export interface TriageSnapshotPayload {
  claims: { paperId: string; claimIndex: number; state: TriageStateValue }[];
  papers: { paperId: string; triageDoneAt: Date; triageDoneBy: string }[];
  comments: { paperId: string; claimIndex: number; body: string }[];
}

export interface TriageBackend {
  load(key: WorkspaceKey): Promise<TriageSnapshotPayload>;
  setClaimState(
    key: WorkspaceKey,
    paperId: string,
    claimIndex: number,
    state: TriageStateValue,
  ): Promise<void>;
  setClaimComment(
    key: WorkspaceKey,
    paperId: string,
    claimIndex: number,
    body: string,
  ): Promise<void>;
  setPaperDone(
    key: WorkspaceKey,
    paperId: string,
    done: boolean,
    user: string,
  ): Promise<void>;
}
