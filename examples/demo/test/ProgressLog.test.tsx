/**
 * Tests for the <ProgressLog> component: renders the in-order event
 * list with one row per event, distinguishes run_done vs run_error
 * styling, and surfaces an empty-state message when the list is empty.
 */

import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { ProgressLog } from "../src/components/literature/ProgressLog";
import type { ProgressEvent } from "../src/lib/progressEvents";

afterEach(() => {
  cleanup();
});

function renderWithProvider(ui: React.ReactNode) {
  return render(<MantineProvider>{ui}</MantineProvider>);
}

describe("<ProgressLog>", () => {
  test("renders the empty-state message when no events", () => {
    renderWithProvider(
      <ProgressLog events={[]} emptyMessage="no events yet" />,
    );
    expect(screen.getByTestId("progress-log-empty")).toHaveTextContent(
      "no events yet",
    );
  });

  test("renders events in input order", () => {
    const events: ProgressEvent[] = [
      {
        timestamp: "2026-05-15T00:00:01.000+00:00",
        stage: "query",
        kind: "stage_started",
      },
      {
        timestamp: "2026-05-15T00:01:00.000+00:00",
        stage: "query",
        kind: "stage_done",
        done: 5,
        total: 5,
      },
      {
        timestamp: "2026-05-15T00:02:00.000+00:00",
        stage: "aggregate",
        kind: "run_done",
        detail: "ok",
      },
    ];
    renderWithProvider(<ProgressLog events={events} />);
    const rendered = screen
      .getAllByTestId(/^progress-event-/)
      .map((el) => el.textContent ?? "");
    expect(rendered).toHaveLength(3);
    expect(rendered[0]).toMatch(/query: started/);
    expect(rendered[1]).toMatch(/query: done.*5\/5/);
    expect(rendered[2]).toMatch(/run: done.*ok/);
  });

  test("renders run_error with the error message", () => {
    const events: ProgressEvent[] = [
      {
        timestamp: "2026-05-15T00:00:01.000+00:00",
        stage: "aggregate",
        kind: "run_error",
        error: "boom",
      },
    ];
    renderWithProvider(<ProgressLog events={events} />);
    expect(screen.getByTestId("progress-event-run_error")).toHaveTextContent(
      "run: error — boom",
    );
  });

  test("renders per-paper counter in `paper` events", () => {
    const events: ProgressEvent[] = [
      {
        timestamp: "2026-05-15T00:00:01.000+00:00",
        stage: "extract",
        kind: "paper",
        paper_id: "10.1234/foo",
        done: 1,
        total: 5,
      },
    ];
    renderWithProvider(<ProgressLog events={events} />);
    const row = screen.getByTestId("progress-event-paper");
    expect(row).toHaveTextContent("extract: 10.1234/foo");
    expect(row).toHaveTextContent("1/5");
  });
});
