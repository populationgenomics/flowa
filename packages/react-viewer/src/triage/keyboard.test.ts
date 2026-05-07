import { describe, it, expect, vi } from "vitest";
import { jumpToNextUnreviewed } from "./keyboard";
import type { Claim, TriageStateValue } from "./types";

const PAPERS = ["Smith2024", "Jones2023"];

const CLAIMS_BY_PAPER = new Map<string, Claim[]>([
  [
    "Smith2024",
    [
      { paperId: "Smith2024", text: "S1", citations: [] },
      { paperId: "Smith2024", text: "S2", citations: [] },
      { paperId: "Smith2024", text: "S3", citations: [] },
    ],
  ],
  [
    "Jones2023",
    [
      { paperId: "Jones2023", text: "J1", citations: [] },
      { paperId: "Jones2023", text: "J2", citations: [] },
    ],
  ],
]);

function makeStates(
  ...entries: Array<[string, number, TriageStateValue]>
): Record<string, TriageStateValue> {
  const out: Record<string, TriageStateValue> = {};
  for (const [paper, idx, state] of entries) {
    out[`${paper}\n${idx}`] = state;
  }
  return out;
}

describe("jumpToNextUnreviewed", () => {
  it("advances within a paper", () => {
    const focusClaim = vi.fn();
    jumpToNextUnreviewed(
      PAPERS,
      CLAIMS_BY_PAPER,
      makeStates(["Smith2024", 1, "ACCEPTED"]),
      "Smith2024",
      1,
      1,
      focusClaim,
    );
    expect(focusClaim).toHaveBeenCalledWith("Smith2024", 2);
  });

  it("skips already-decided claims", () => {
    const focusClaim = vi.fn();
    jumpToNextUnreviewed(
      PAPERS,
      CLAIMS_BY_PAPER,
      makeStates(["Smith2024", 1, "ACCEPTED"], ["Smith2024", 2, "REJECTED"]),
      "Smith2024",
      1,
      1,
      focusClaim,
    );
    expect(focusClaim).toHaveBeenCalledWith("Smith2024", 3);
  });

  it("rolls over to the next paper when the current paper has no unreviewed claims left", () => {
    const focusClaim = vi.fn();
    jumpToNextUnreviewed(
      PAPERS,
      CLAIMS_BY_PAPER,
      makeStates(
        ["Smith2024", 1, "ACCEPTED"],
        ["Smith2024", 2, "ACCEPTED"],
        ["Smith2024", 3, "ACCEPTED"],
      ),
      "Smith2024",
      1,
      1,
      focusClaim,
    );
    expect(focusClaim).toHaveBeenCalledWith("Jones2023", 1);
  });

  it("walks backwards with dir=-1, wrapping at the start", () => {
    const focusClaim = vi.fn();
    jumpToNextUnreviewed(
      PAPERS,
      CLAIMS_BY_PAPER,
      makeStates(["Smith2024", 1, "ACCEPTED"], ["Smith2024", 2, "ACCEPTED"]),
      "Smith2024",
      3,
      -1,
      focusClaim,
    );
    // From (Smith2024, 3) walking backwards: (Smith2024, 2) is decided,
    // (Smith2024, 1) is decided, wrap to (Jones2023, 2), unreviewed.
    expect(focusClaim).toHaveBeenCalledWith("Jones2023", 2);
  });

  it("does nothing when the entire grid is decided", () => {
    const focusClaim = vi.fn();
    jumpToNextUnreviewed(
      PAPERS,
      CLAIMS_BY_PAPER,
      makeStates(
        ["Smith2024", 1, "ACCEPTED"],
        ["Smith2024", 2, "ACCEPTED"],
        ["Smith2024", 3, "ACCEPTED"],
        ["Jones2023", 1, "REJECTED"],
        ["Jones2023", 2, "REJECTED"],
      ),
      "Smith2024",
      1,
      1,
      focusClaim,
    );
    expect(focusClaim).not.toHaveBeenCalled();
  });

  it("returns silently when papers list is empty or startPaper is null", () => {
    const focusClaim = vi.fn();
    jumpToNextUnreviewed([], new Map(), {}, null, 1, 1, focusClaim);
    expect(focusClaim).not.toHaveBeenCalled();
    jumpToNextUnreviewed(PAPERS, CLAIMS_BY_PAPER, {}, null, 1, 1, focusClaim);
    expect(focusClaim).not.toHaveBeenCalled();
  });
});
