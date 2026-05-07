/**
 * Keyboard shortcut hook for the triage workspace.
 *
 * Shortcut table:
 *   a  accept / toggle
 *   r  reject / toggle
 *   n  next unreviewed claim anywhere
 *   p  prev unreviewed claim anywhere
 *   ]  next paper (wraps)
 *   [  prev paper (wraps)
 *   ↓  next claim in current paper
 *   ↑  prev claim in current paper
 *   c  open comment box for focused claim
 *   ?  open chat drawer
 *   e  cycle supporting quote on PDF (when multi-citation)
 */

import { useEffect } from "react";
import { useTriageStore } from "./store";
import type { Claim, TriageStateValue } from "./types";

interface KeyboardContext {
  papers: readonly string[];
  claimsByPaper: Map<string, Claim[]>;
  onAccept(paperId: string, claimIndex: number): void;
  onReject(paperId: string, claimIndex: number): void;
  onOpenComment(paperId: string, claimIndex: number): void;
  onOpenChat(): void;
  onCycleQuote(): void;
}

function shouldIgnore(e: KeyboardEvent): boolean {
  if (e.metaKey || e.altKey || e.ctrlKey) return true;
  const target = e.target as HTMLElement | null;
  if (!target) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

export function useTriageKeyboard(ctx: KeyboardContext): void {
  const {
    focusedPaperId,
    focusedClaimIndex,
    claimStates,
    focusClaim,
    focusPaper,
  } = useTriageStore();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (shouldIgnore(e)) return;

      const paperId = focusedPaperId ?? ctx.papers[0] ?? null;
      const claimIdx = focusedClaimIndex ?? 1;
      const claimsHere = paperId ? (ctx.claimsByPaper.get(paperId) ?? []) : [];

      const nextClaimInPaper = () => {
        if (!paperId) return;
        const next = Math.min(claimIdx + 1, claimsHere.length);
        focusClaim(paperId, next);
      };
      const prevClaimInPaper = () => {
        if (!paperId) return;
        const prev = Math.max(claimIdx - 1, 1);
        focusClaim(paperId, prev);
      };

      switch (e.key) {
        case "a":
          if (!paperId) return;
          e.preventDefault();
          ctx.onAccept(paperId, claimIdx);
          break;
        case "r":
          if (!paperId) return;
          e.preventDefault();
          ctx.onReject(paperId, claimIdx);
          break;
        case "n":
          e.preventDefault();
          jumpToNextUnreviewed(
            ctx.papers,
            ctx.claimsByPaper,
            claimStates,
            paperId,
            claimIdx,
            1,
            focusClaim,
          );
          break;
        case "p":
          e.preventDefault();
          jumpToNextUnreviewed(
            ctx.papers,
            ctx.claimsByPaper,
            claimStates,
            paperId,
            claimIdx,
            -1,
            focusClaim,
          );
          break;
        case "]":
          e.preventDefault();
          if (ctx.papers.length) {
            const i = paperId ? ctx.papers.indexOf(paperId) : -1;
            const next = ctx.papers[(i + 1) % ctx.papers.length]!;
            focusPaper(next);
          }
          break;
        case "[":
          e.preventDefault();
          if (ctx.papers.length) {
            const i = paperId ? ctx.papers.indexOf(paperId) : -1;
            const next =
              ctx.papers[(i - 1 + ctx.papers.length) % ctx.papers.length]!;
            focusPaper(next);
          }
          break;
        case "ArrowDown":
          e.preventDefault();
          nextClaimInPaper();
          break;
        case "ArrowUp":
          e.preventDefault();
          prevClaimInPaper();
          break;
        case "c":
          if (!paperId) return;
          e.preventDefault();
          ctx.onOpenComment(paperId, claimIdx);
          break;
        case "?":
          e.preventDefault();
          ctx.onOpenChat();
          break;
        case "e":
          e.preventDefault();
          ctx.onCycleQuote();
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    ctx,
    focusedPaperId,
    focusedClaimIndex,
    claimStates,
    focusClaim,
    focusPaper,
  ]);
}

/**
 * Walk the (paper, claim) grid forwards (`dir=1`) or backwards (`dir=-1`),
 * landing on the first claim whose state is `UNREVIEWED`. Wraps at paper
 * boundaries; never revisits the starting (paper, claim).
 */
export function jumpToNextUnreviewed(
  papers: readonly string[],
  claimsByPaper: Map<string, Claim[]>,
  claimStates: Record<string, TriageStateValue>,
  startPaper: string | null,
  startClaim: number,
  dir: 1 | -1,
  focusClaim: (p: string, i: number) => void,
): void {
  if (!papers.length || !startPaper) return;
  const paperIdx = papers.indexOf(startPaper);
  if (paperIdx < 0) return;

  const total = papers.reduce(
    (sum, p) => sum + (claimsByPaper.get(p)?.length ?? 0),
    0,
  );

  let pi = paperIdx;
  let ci = startClaim;
  for (let step = 0; step < total; step++) {
    if (dir === 1) {
      ci += 1;
      const here = claimsByPaper.get(papers[pi]!) ?? [];
      while (ci > here.length) {
        pi = (pi + 1) % papers.length;
        ci = 1;
        const next = claimsByPaper.get(papers[pi]!) ?? [];
        if (next.length === 0) continue;
        break;
      }
    } else {
      ci -= 1;
      while (ci < 1) {
        pi = (pi - 1 + papers.length) % papers.length;
        const prev = claimsByPaper.get(papers[pi]!) ?? [];
        if (prev.length === 0) continue;
        ci = prev.length;
      }
    }
    const paperAtPi = papers[pi]!;
    const claimsAtPi = claimsByPaper.get(paperAtPi) ?? [];
    if (ci < 1 || ci > claimsAtPi.length) continue;
    const key = `${paperAtPi}\n${ci}`;
    const state = claimStates[key] ?? "UNREVIEWED";
    if (state === "UNREVIEWED") {
      focusClaim(paperAtPi, ci);
      return;
    }
  }
}
