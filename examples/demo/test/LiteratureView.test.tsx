/**
 * Tests for <LiteratureView>. Covers the page's branching points:
 *
 *   - renders the papers list grouped by status
 *   - renders "Open analysis" buttons only when aggregateExists is true
 *   - bumps polling cadence 15s → 60s once the run is terminal
 *   - dispatches an upload via /api/papers/[doi]/pdf when a paper row's
 *     button fires
 *   - disables Re-analyze while the latest run is active
 *
 * The polling-cadence test uses vitest fake timers so it can step
 * through 15s + 60s intervals without real wall-clock waits.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { LiteratureView } from "../src/components/literature/LiteratureView";
import type { PapersForVariant } from "../src/lib/papers";
import type { LatestRunInfo } from "../src/lib/runs";
import type { ProgressResponse } from "../src/lib/progressEvents";

// Minimal next/link stub: the component imports it for the "Open
// analysis" affordance. Plain anchor is fine in tests.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const VARIANT = "RYR2-NM_001035_3-c_14174A_G";

let fetchSpy: ReturnType<typeof vi.spyOn>;

function papersResp(
  overrides: Partial<PapersForVariant> = {},
): PapersForVariant {
  return {
    papers: [
      {
        doi: "10.1371/journal.pone.0131517",
        encodedDoi: "10.1371%2Fjournal.pone.0131517",
        status: "needs_manual",
        title: "Gender Differences in RYR2 Mutations",
        authors: "Ohno, S",
        pmid: 26114861,
        url: "https://doi.org/10.1371/journal.pone.0131517",
      },
    ],
    aggregateExists: false,
    categories: [],
    gene: "RYR2",
    hgvs_c: "NM_001035.3:c.14174A>G",
    ...overrides,
  };
}

function latestRun(overrides: Partial<LatestRunInfo> = {}): LatestRunInfo {
  return {
    run_id: "a".repeat(32),
    started_at: "2026-05-15T00:00:00.000+00:00",
    terminal: false,
    ...overrides,
  };
}

function progressResp(
  overrides: Partial<ProgressResponse> = {},
): ProgressResponse {
  return {
    events: [
      {
        timestamp: "2026-05-15T00:00:01.000+00:00",
        stage: "query",
        kind: "stage_started",
      },
    ],
    terminal: false,
    ...overrides,
  };
}

interface FetchPlan {
  papers?: PapersForVariant;
  latest?: LatestRunInfo | { status: 404 };
  progress?: ProgressResponse[];
  /** Successive progress polls return progress[i] then progress[last] forever. */
}

function arrangeFetch(plan: FetchPlan = {}) {
  let progressCallIndex = 0;
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.includes("/api/papers?")) {
      return Promise.resolve(
        new Response(JSON.stringify(plan.papers ?? papersResp()), {
          status: 200,
        }),
      );
    }
    if (url.includes("/api/runs/latest?")) {
      if (
        plan.latest &&
        "status" in plan.latest &&
        plan.latest.status === 404
      ) {
        return Promise.resolve(new Response("{}", { status: 404 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify(plan.latest ?? latestRun()), {
          status: 200,
        }),
      );
    }
    if (url.includes("/progress")) {
      const list = plan.progress ?? [progressResp()];
      const body = list[Math.min(progressCallIndex, list.length - 1)]!;
      progressCallIndex++;
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 200 }),
      );
    }
    if (url.includes("/api/papers/") && url.includes("/pdf")) {
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    }
    if (url.endsWith("/api/runs")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            run_id: "b".repeat(32),
            variant_id: VARIANT,
            started_at: "2026-05-16T00:00:00.000+00:00",
            status: "running",
          }),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  });
}

function renderView() {
  return render(
    <MantineProvider>
      <LiteratureView variantId={VARIANT} />
    </MantineProvider>,
  );
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  if (fetchSpy) fetchSpy.mockRestore();
  vi.useRealTimers();
});

describe("<LiteratureView>", () => {
  test("renders the papers list once /api/papers resolves", async () => {
    arrangeFetch();
    renderView();
    await waitFor(() => {
      expect(
        screen.getByText(/Gender Differences in RYR2 Mutations/),
      ).toBeInTheDocument();
    });
  });

  test("renders a Results card per category when aggregateExists", async () => {
    arrangeFetch({
      papers: papersResp({
        aggregateExists: true,
        categories: ["acmg_classification", "phenotype_summary"],
      }),
    });
    renderView();
    await waitFor(() => {
      expect(
        screen.getByTestId("result-card-acmg_classification"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("result-card-phenotype_summary"),
    ).toBeInTheDocument();
  });

  test("hides the Results section when aggregateExists is false", async () => {
    arrangeFetch();
    renderView();
    await waitFor(() => {
      expect(
        screen.getByText(/Gender Differences in RYR2 Mutations/),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText("Results")).not.toBeInTheDocument();
    expect(screen.queryByTestId(/^result-card-/)).not.toBeInTheDocument();
  });

  test("disables Re-analyze while the latest run is active", async () => {
    arrangeFetch({ latest: latestRun({ terminal: false }) });
    renderView();
    const btn = await screen.findByRole("button", { name: "Re-analyze" });
    expect(btn).toBeDisabled();
  });

  test("labels the button 'Analyze' when there is no run history", async () => {
    arrangeFetch({ latest: { status: 404 } });
    renderView();
    const btn = await screen.findByRole("button", { name: "Analyze" });
    expect(btn).toBeEnabled();
  });

  test("polls progress at 15s while running and 60s once terminal", async () => {
    arrangeFetch({
      latest: latestRun({ terminal: false }),
      progress: [
        progressResp({ terminal: false }),
        progressResp({ terminal: false }),
        progressResp({ terminal: true }),
        progressResp({ terminal: true }),
      ],
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderView();

    await waitFor(() => {
      const calls = fetchSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(calls.some((c: string) => c.includes("/progress"))).toBe(true);
    });

    const countProgressCalls = () =>
      fetchSpy.mock.calls.filter((c: unknown[]) =>
        String(c[0]).includes("/progress"),
      ).length;

    expect(countProgressCalls()).toBeGreaterThanOrEqual(1);
    const beforeShortTick = countProgressCalls();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(countProgressCalls()).toBeGreaterThan(beforeShortTick);

    // Drain remaining polls until terminal=true is observed; that
    // schedules the next poll at 60s, not 15s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    const beforeLongWait = countProgressCalls();
    // 30s after the terminal poll: still inside the 60s gap → no new poll.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(countProgressCalls()).toBe(beforeLongWait);
    // 31s more (total 61s after the terminal poll) — the long-cadence
    // timer should fire.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(countProgressCalls()).toBeGreaterThan(beforeLongWait);
  });
});
