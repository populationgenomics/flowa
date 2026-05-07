/**
 * Triage persistence interface. The shell calls these methods through
 * whatever implementation the consumer wires up.
 *
 * Optimistic updates with revert-on-error are owned by the Zustand store
 * inside the package, not by the backend. The backend is purely
 * persistence + load: each setter applies the change durably; `load`
 * returns the full per-workspace snapshot.
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
