// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import type { ReactNode } from "react";
import { MarkdownHighlightViewer } from "./MarkdownHighlightViewer";
import { ANCHOR_MARK_CLASS } from "./plugins";
import type { CodePointAnchor } from "./types";

const wrap = (node: ReactNode) => <MantineProvider>{node}</MantineProvider>;

function stubFetch(text: string, ok = true, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        ({ ok, status, text: async () => text }) as unknown as Response,
    ),
  );
}

beforeEach(() => {
  // happy-dom doesn't implement scrollIntoView; the viewer calls it post-render.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MarkdownHighlightViewer", () => {
  it("highlights the anchored quote once the Markdown loads", async () => {
    const md = "The variant p.Arg175His is pathogenic.";
    stubFetch(md);
    const start = md.indexOf("p.Arg175His");
    const anchor: CodePointAnchor = {
      start,
      end: start + "p.Arg175His".length,
    };
    const { container } = render(
      wrap(
        <MarkdownHighlightViewer
          markdownUrl="/md"
          anchor={anchor}
          label="p.Arg175His"
        />,
      ),
    );
    await waitFor(() =>
      expect(
        container.querySelector(`mark.${ANCHOR_MARK_CLASS}`),
      ).not.toBeNull(),
    );
    expect(
      container.querySelector(`mark.${ANCHOR_MARK_CLASS}`)!.textContent,
    ).toBe("p.Arg175His");
  });

  it("renders without a highlight in browse mode (no anchor)", async () => {
    stubFetch("Just some text.");
    const { container } = render(
      wrap(<MarkdownHighlightViewer markdownUrl="/md" />),
    );
    await waitFor(() =>
      expect(container.textContent).toContain("Just some text."),
    );
    expect(container.querySelector("mark")).toBeNull();
    expect(screen.queryByText(/Could not locate/)).toBeNull();
  });

  it("shows a locating alert while the anchor is pending", async () => {
    stubFetch("text");
    render(
      wrap(
        <MarkdownHighlightViewer
          markdownUrl="/md"
          label="some quote"
          pending
        />,
      ),
    );
    expect(await screen.findByText(/Locating quote in Markdown/)).toBeDefined();
    expect(screen.getByText(/some quote/)).toBeDefined();
  });

  it("warns when the quote could not be located", async () => {
    stubFetch("text");
    render(
      wrap(
        <MarkdownHighlightViewer
          markdownUrl="/md"
          label="missing quote"
          anchor={null}
        />,
      ),
    );
    expect(
      await screen.findByText(/Could not locate quote in Markdown/),
    ).toBeDefined();
  });

  it("surfaces a fetch error", async () => {
    stubFetch("", false, 404);
    render(wrap(<MarkdownHighlightViewer markdownUrl="/md" />));
    expect(await screen.findByText(/Failed to load Markdown/)).toBeDefined();
  });
});
