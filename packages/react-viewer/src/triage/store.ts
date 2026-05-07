/**
 * Zustand store for the triage workspace. Holds the per-claim decisions,
 * paper-done timestamps, comments, and focus cursor for whichever artifact
 * version the shell is currently rendering.
 *
 * The store is purely client-side: optimistic updates fire here first;
 * `applyClaimState` / `applyPaperDone` / `applyClaimComment` return the
 * previous value so the shell can revert via a second `apply...` call when
 * the backend mutation fails.
 *
 * Loading triage state from the backend is the shell's responsibility: it
 * calls `TriageBackend.load(workspaceKey)` and then `loadFromServer(...)`
 * with the result.
 */

import { create } from "zustand";
import type { TriageStateValue, WorkspaceKey } from "./types";

/** `${paperId}\n${claimIndex}` — newline is not valid in a paperId. */
export type ClaimKey = string;

export function claimKey(paperId: string, claimIndex: number): ClaimKey {
  return `${paperId}\n${claimIndex}`;
}

export interface TriageStoreData {
  workspaceKey: WorkspaceKey | null;
  claimStates: Record<ClaimKey, TriageStateValue>;
  papersDone: Record<string, { triageDoneAt: Date; triageDoneBy: string }>;
  comments: Record<ClaimKey, string>;

  focusedPaperId: string | null;
  focusedClaimIndex: number | null;
  chatDrawerOpen: boolean;
  showMoreInPaper: Record<string, boolean>;
}

export interface TriageStoreActions {
  setWorkspaceKey(key: WorkspaceKey | null): void;
  loadFromServer(payload: {
    workspaceKey: WorkspaceKey;
    claims: Array<{
      paperId: string;
      claimIndex: number;
      state: TriageStateValue;
    }>;
    papers: Array<{
      paperId: string;
      triageDoneAt: Date;
      triageDoneBy: string;
    }>;
    comments: Array<{ paperId: string; claimIndex: number; body: string }>;
  }): void;

  /**
   * Optimistic per-claim update. Returns the previous value so the caller
   * can revert on backend error by calling `applyClaimState(..., prev)`.
   */
  applyClaimState(
    paperId: string,
    claimIndex: number,
    state: TriageStateValue,
  ): TriageStateValue;
  /** Returns whether the paper was previously marked done. */
  applyPaperDone(paperId: string, done: boolean, user: string): boolean;
  /** Returns the previous comment body (empty string if none). */
  applyClaimComment(paperId: string, claimIndex: number, body: string): string;

  focusClaim(paperId: string, claimIndex: number): void;
  focusPaper(paperId: string): void;
  toggleChatDrawer(open?: boolean): void;
  setShowMore(paperId: string, show: boolean): void;

  reset(): void;
}

export type TriageStore = TriageStoreData & TriageStoreActions;

const initial: TriageStoreData = {
  workspaceKey: null,
  claimStates: {},
  papersDone: {},
  comments: {},
  focusedPaperId: null,
  focusedClaimIndex: null,
  chatDrawerOpen: false,
  showMoreInPaper: {},
};

export const useTriageStore = create<TriageStore>((set, get) => ({
  ...initial,

  setWorkspaceKey(workspaceKey) {
    set({ workspaceKey });
  },

  loadFromServer({ workspaceKey, claims, papers, comments }) {
    const claimStates: Record<ClaimKey, TriageStateValue> = {};
    for (const c of claims) {
      claimStates[claimKey(c.paperId, c.claimIndex)] = c.state;
    }
    const papersDone: Record<
      string,
      { triageDoneAt: Date; triageDoneBy: string }
    > = {};
    for (const p of papers) {
      papersDone[p.paperId] = {
        triageDoneAt: p.triageDoneAt,
        triageDoneBy: p.triageDoneBy,
      };
    }
    const commentMap: Record<ClaimKey, string> = {};
    for (const c of comments) {
      commentMap[claimKey(c.paperId, c.claimIndex)] = c.body;
    }
    set({
      workspaceKey,
      claimStates,
      papersDone,
      comments: commentMap,
      focusedPaperId: get().focusedPaperId,
      focusedClaimIndex: get().focusedClaimIndex,
    });
  },

  applyClaimState(paperId, claimIndex, state) {
    const key = claimKey(paperId, claimIndex);
    const prev = get().claimStates[key] ?? "UNREVIEWED";
    set({ claimStates: { ...get().claimStates, [key]: state } });
    return prev;
  },

  applyPaperDone(paperId, done, user) {
    const prev = get().papersDone[paperId];
    const next = { ...get().papersDone };
    if (done) {
      next[paperId] = { triageDoneAt: new Date(), triageDoneBy: user };
    } else {
      delete next[paperId];
    }
    set({ papersDone: next });
    return prev != null;
  },

  applyClaimComment(paperId, claimIndex, body) {
    const key = claimKey(paperId, claimIndex);
    const prev = get().comments[key] ?? "";
    const next = { ...get().comments };
    if (body === "") delete next[key];
    else next[key] = body;
    set({ comments: next });
    return prev;
  },

  focusClaim(paperId, claimIndex) {
    set({ focusedPaperId: paperId, focusedClaimIndex: claimIndex });
  },

  focusPaper(paperId) {
    set({ focusedPaperId: paperId, focusedClaimIndex: 1 });
  },

  toggleChatDrawer(open) {
    set({
      chatDrawerOpen: open === undefined ? !get().chatDrawerOpen : open,
    });
  },

  setShowMore(paperId, show) {
    set({
      showMoreInPaper: { ...get().showMoreInPaper, [paperId]: show },
    });
  },

  reset() {
    set({ ...initial });
  },
}));
