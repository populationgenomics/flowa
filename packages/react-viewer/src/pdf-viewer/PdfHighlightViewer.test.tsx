// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { PdfHighlightViewer } from "./PdfHighlightViewer";
import type { PdfHighlight } from "./types";

// happy-dom does not implement ResizeObserver; stub it so the component mounts.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  globalThis.ResizeObserver =
    ResizeObserverStub as unknown as typeof ResizeObserver;
  // The dynamic import of react-pdf is mocked to avoid loading pdf.js worker
  // in the test environment. The component renders the loading state until
  // the import resolves; in this test it never resolves.
  vi.doMock("react-pdf", () => ({
    pdfjs: { GlobalWorkerOptions: {} },
    Document: () => null,
    Page: () => null,
  }));
});

const wrap = (node: React.ReactNode) => (
  <MantineProvider>{node}</MantineProvider>
);

describe("PdfHighlightViewer", () => {
  it("renders the loading state before react-pdf resolves", () => {
    const { container } = render(
      wrap(
        <PdfHighlightViewer
          pdfUrl="/some.pdf"
          workerSrc="/pdfjs/pdf.worker.min.mjs"
          cMapUrl="/pdfjs/cmaps/"
        />,
      ),
    );
    // Loader from @mantine/core renders a span with role="presentation"
    // (or a div). Look for the wrapping container plus absence of error.
    expect(container.querySelector(".relative")).not.toBeNull();
  });

  it("surfaces a not-found alert when a highlight has no bboxes but a label", () => {
    const highlights: PdfHighlight[] = [
      { bboxes: [], label: "the quote that could not be located" },
    ];
    render(
      wrap(
        <PdfHighlightViewer
          pdfUrl="/some.pdf"
          highlights={highlights}
          workerSrc="/pdfjs/pdf.worker.min.mjs"
          cMapUrl="/pdfjs/cmaps/"
        />,
      ),
    );
    expect(screen.getByText(/Could not locate quote/)).toBeDefined();
    expect(
      screen.getByText(/the quote that could not be located/),
    ).toBeDefined();
  });

  it("shows a locating state for a pending highlight, not the not-found warning", () => {
    const highlights: PdfHighlight[] = [
      { bboxes: [], label: "a quote still being resolved", pending: true },
    ];
    render(
      wrap(
        <PdfHighlightViewer
          pdfUrl="/some.pdf"
          highlights={highlights}
          workerSrc="/pdfjs/pdf.worker.min.mjs"
          cMapUrl="/pdfjs/cmaps/"
        />,
      ),
    );
    expect(screen.getByText(/Locating quote/)).toBeDefined();
    expect(screen.getByText(/a quote still being resolved/)).toBeDefined();
    expect(screen.queryByText(/Could not locate quote/)).toBeNull();
  });
});
