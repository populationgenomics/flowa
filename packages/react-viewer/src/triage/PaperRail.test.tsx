// @vitest-environment happy-dom

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { PaperRail } from "./PaperRail";
import type { PaperIdMapping } from "../citations/types";
import type { Claim, RankedPaper, TriageStateValue } from "./types";

const PAPERS: RankedPaper[] = [
  { paperId: "Smith2024", rankRationale: "Functional." },
  { paperId: "Jones2023", rankRationale: "Clinical." },
];

const MAPPING: PaperIdMapping = {
  byAuthorYear: {
    Smith2024: { doi: "10.1234/smith.2024", pmid: 39012345 },
    Jones2023: { doi: "10.1234/jones.2023" },
  },
  byDoi: {
    "10.1234/smith.2024": "Smith2024",
    "10.1234/jones.2023": "Jones2023",
  },
};

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
  paperIdMapping?: PaperIdMapping;
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
        paperIdMapping={opts.paperIdMapping}
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

  it("shows the PubMed id under the cite key, or the DOI without one", () => {
    renderRail({ paperIdMapping: MAPPING });
    expect(screen.getByTestId("paper-identifier-Smith2024").textContent).toBe(
      "PMID 39012345",
    );
    expect(screen.getByTestId("paper-identifier-Jones2023").textContent).toBe(
      "10.1234/jones.2023",
    );
  });

  it("carries the full identifier as the tooltip of the truncated line", () => {
    renderRail({ paperIdMapping: MAPPING });
    expect(
      screen.getByTestId("paper-identifier-Jones2023").getAttribute("title"),
    ).toBe("10.1234/jones.2023");
  });

  it("shows no identifier line without a mapping", () => {
    renderRail({});
    expect(screen.queryByTestId("paper-identifier-Smith2024")).toBeNull();
    expect(screen.queryByTestId("paper-identifier-Jones2023")).toBeNull();
  });

  it("omits the line for the one paper the mapping does not know", () => {
    renderRail({
      paperIdMapping: {
        byAuthorYear: { Smith2024: MAPPING.byAuthorYear.Smith2024! },
        byDoi: { "10.1234/smith.2024": "Smith2024" },
      },
    });
    expect(screen.getByTestId("paper-identifier-Smith2024").textContent).toBe(
      "PMID 39012345",
    );
    expect(screen.queryByTestId("paper-identifier-Jones2023")).toBeNull();
  });

  it("calls onFocusPaper with the paperId on click", () => {
    const onFocusPaper = vi.fn();
    renderRail({ onFocusPaper });
    fireEvent.click(screen.getByTestId("paper-row-Jones2023"));
    expect(onFocusPaper).toHaveBeenCalledWith("Jones2023");
  });
});
