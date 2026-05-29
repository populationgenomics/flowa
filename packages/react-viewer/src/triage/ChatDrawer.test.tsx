// @vitest-environment happy-dom

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import type { UIMessage } from "ai";
import { ChatDrawer } from "./ChatDrawer";
import type { PaperIdMapping } from "../citations/types";

const MAPPING: PaperIdMapping = { byAuthorYear: {}, byDoi: {} };

function renderDrawer(
  messages: UIMessage[],
  overrides: Partial<Parameters<typeof ChatDrawer>[0]> = {},
) {
  return render(
    <MantineProvider>
      <ChatDrawer
        isOpen
        onOpenChange={vi.fn()}
        messages={messages}
        status="streaming"
        error={undefined}
        input=""
        onInputChange={vi.fn()}
        onSend={vi.fn()}
        paperIdMapping={MAPPING}
        {...overrides}
      />
    </MantineProvider>,
  );
}

// Parts are easier to author as plain objects than to build from the SDK's
// discriminated unions; cast through unknown at the message boundary.
function assistant(parts: unknown[]): UIMessage {
  return { id: "m1", role: "assistant", parts } as unknown as UIMessage;
}
function user(text: string): UIMessage {
  return {
    id: "u1",
    role: "user",
    parts: [{ type: "text", text }],
  } as unknown as UIMessage;
}

describe("ChatDrawer activity trace", () => {
  it("shows the tool name and a spinner while a tool is in flight", () => {
    renderDrawer([
      assistant([
        {
          type: "dynamic-tool",
          toolName: "searchPaper",
          toolCallId: "t1",
          state: "input-available",
          input: { paperId: "P1", pattern: "BRCA" },
        },
      ]),
    ]);
    expect(screen.getByText("searchPaper")).toBeDefined();
    expect(screen.getByTestId("tool-spinner")).toBeDefined();
    expect(
      screen.getByTestId("tool-step-header").getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("marks a completed tool as a success and shows its output without expanding", () => {
    renderDrawer([
      assistant([
        {
          type: "dynamic-tool",
          toolName: "searchPaper",
          toolCallId: "t1",
          state: "output-available",
          input: { paperId: "P1" },
          output: "3 matches",
        },
      ]),
    ]);
    expect(screen.getByTestId("tool-status").getAttribute("data-state")).toBe(
      "output-available",
    );
    expect(
      screen.getByTestId("tool-step-header").getAttribute("aria-expanded"),
    ).toBe("false");
    expect(screen.getByTestId("tool-output-summary").textContent).toContain(
      "3 matches",
    );
  });

  it("shows an errored tool's message without expanding", () => {
    renderDrawer([
      assistant([
        {
          type: "dynamic-tool",
          toolName: "str_replace",
          toolCallId: "t1",
          state: "output-error",
          input: { old_str: "a", new_str: "b" },
          errorText: "old_str not found in artifact.",
        },
      ]),
    ]);
    expect(
      screen.getByTestId("tool-step-header").getAttribute("aria-expanded"),
    ).toBe("false");
    expect(screen.getByTestId("tool-output-summary").textContent).toContain(
      "old_str not found",
    );
  });

  it("reveals input and output when a tool row is expanded", () => {
    renderDrawer([
      assistant([
        {
          type: "dynamic-tool",
          toolName: "searchPaper",
          toolCallId: "t1",
          state: "output-available",
          input: { paperId: "P1" },
          output: "3 matches",
        },
      ]),
    ]);
    fireEvent.click(screen.getByTestId("tool-step-header"));
    expect(
      screen.getByTestId("tool-step-header").getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.getByTestId("payload-input").textContent).toContain("P1");
    expect(screen.getByTestId("payload-output").textContent).toContain(
      "3 matches",
    );
  });

  it("auto-expands reasoning while streaming", () => {
    renderDrawer([
      assistant([
        {
          type: "reasoning",
          state: "streaming",
          text: "weighing the evidence",
        },
      ]),
    ]);
    expect(
      screen.getByTestId("reasoning-step-header").getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.getByTestId("reasoning-text").textContent).toContain(
      "weighing the evidence",
    );
  });

  it("shows finished reasoning by default and allows collapsing it", () => {
    renderDrawer([
      assistant([
        { type: "reasoning", state: "done", text: "settled conclusion" },
      ]),
    ]);
    const header = screen.getByTestId("reasoning-step-header");
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("reasoning-text").textContent).toContain(
      "settled conclusion",
    );
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });

  it("truncates a large edit payload", () => {
    renderDrawer([
      assistant([
        {
          type: "dynamic-tool",
          toolName: "write",
          toolCallId: "t1",
          state: "output-available",
          input: { artifact_yaml: "x".repeat(5000) },
          output: "ok",
        },
      ]),
    ]);
    fireEvent.click(screen.getByTestId("tool-step-header"));
    const input = screen.getByTestId("payload-input").textContent ?? "";
    expect(input).toContain("truncated");
    expect(input.length).toBeLessThan(2200);
  });

  it("still renders assistant text as Markdown", () => {
    renderDrawer([assistant([{ type: "text", text: "**hi**" }])]);
    expect(screen.getByText("hi")).toBeDefined();
  });

  it("shows a spinner while waiting for the first assistant part", () => {
    const { container } = renderDrawer([user("please update the assessment")]);
    expect(
      container.querySelectorAll(".mantine-Loader-root").length,
    ).toBeGreaterThanOrEqual(1);
  });
});
