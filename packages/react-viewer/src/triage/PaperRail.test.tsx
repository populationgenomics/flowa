// @vitest-environment happy-dom

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { PaperRail } from "./PaperRail";
import type { Claim, RankedPaper, TriageStateValue } from "./types";

const PAPERS: RankedPaper[] = [
  { paperId: "Smith2024", rankRationale: "Functional." },
  { paperId: "Jones2023", rankRationale: "Clinical." },
];

const CLAIMS_BY_PAPER = new Map<string, Claim[]>([
  [
    "Smith2024",
    [
      { paperId: "Smith2024", text: "S1", citations: [] },
      { paperId: "Smith2024", text: "S2", citations: [] },
    ],
  ],
  ["Jones2023", [{ paperId: "Jones2023", text: "J1", citations: [] }]],
]);

function renderRail(opts: {
  states?: Record<string, TriageStateValue>;
  papersDone?: Record<string, { triageDoneAt: Date; triageDoneBy: string }>;
  focusedPaperId?: string | null;
  onFocusPaper?: (id: string) => void;
}) {
  const onFocusPaper = opts.onFocusPaper ?? vi.fn();
  return render(
    <MantineProvider>
      <PaperRail
        papers={PAPERS}
        claimsByPaper={CLAIMS_BY_PAPER}
        claimStates={opts.states ?? {}}
        papersDone={opts.papersDone ?? {}}
        focusedPaperId={opts.focusedPaperId ?? null}
        onFocusPaper={onFocusPaper}
      />
    </MantineProvider>,
  );
}

describe("PaperRail", () => {
  it("renders one button per paper with rank prefix", () => {
    renderRail({});
    expect(screen.getByTestId("paper-row-Smith2024").textContent).toContain(
      "#1 Smith2024",
    );
    expect(screen.getByTestId("paper-row-Jones2023").textContent).toContain(
      "#2 Jones2023",
    );
  });

  it("shows decided / total counts derived from claimStates", () => {
    renderRail({
      states: {
        "Smith2024\n1": "ACCEPTED",
        "Smith2024\n2": "REJECTED",
      },
    });
    // Smith2024 row reads "2/2 ✓1 ✗1".
    const row = screen.getByTestId("paper-row-Smith2024");
    expect(row.textContent).toContain("2/2");
    expect(row.textContent).toContain("✓1");
    expect(row.textContent).toContain("✗1");
  });

  it("renders the ✓ done badge when papersDone has an entry", () => {
    renderRail({
      papersDone: {
        Smith2024: {
          triageDoneAt: new Date("2026-05-07T00:00:00Z"),
          triageDoneBy: "alice",
        },
      },
    });
    expect(screen.getByTestId("paper-row-Smith2024").textContent).toContain(
      "✓ done",
    );
  });

  it("calls onFocusPaper with the paperId on click", () => {
    const onFocusPaper = vi.fn();
    renderRail({ onFocusPaper });
    fireEvent.click(screen.getByTestId("paper-row-Jones2023"));
    expect(onFocusPaper).toHaveBeenCalledWith("Jones2023");
  });
});
