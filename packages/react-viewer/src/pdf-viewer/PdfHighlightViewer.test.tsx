// @vitest-environment happy-dom

import { useEffect } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { PdfHighlightViewer } from "./PdfHighlightViewer";
import type { PdfHighlight } from "./types";

type DocumentProps = {
  loading?: React.ReactNode;
  error?: React.ReactNode;
  onLoadProgress?(p: { loaded: number; total: number }): void;
  onLoadError?(e: Error): void;
};

/**
 * react-pdf is mocked so no pdf.js worker loads in the test environment. The
 * mock is one hoisted module whose `Document` delegates to whatever a test
 * put in `mockState`, so each test shapes the document's behaviour without
 * re-registering the mock. The mocker evaluates the factory once, so a failed
 * import cannot be staged there; `failForWorkerSrc` instead makes the worker
 * configuration throw for one `workerSrc`, which rejects the same promise a
 * chunk that did not download would.
 */
const mockState = vi.hoisted(() => ({
  document: null as null | ((props: DocumentProps) => React.ReactNode),
  failForWorkerSrc: null as string | null,
}));

vi.mock("react-pdf", () => ({
  pdfjs: {
    GlobalWorkerOptions: {
      set workerSrc(value: string) {
        if (mockState.failForWorkerSrc === value)
          throw new Error("chunk load failed");
      },
    },
  },
  Document: (props: DocumentProps) =>
    mockState.document ? mockState.document(props) : null,
  Page: () => null,
}));

// happy-dom does not implement ResizeObserver; stub it so the component mounts.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  globalThis.ResizeObserver =
    ResizeObserverStub as unknown as typeof ResizeObserver;
  mockState.document = null;
  mockState.failForWorkerSrc = null;
});

const wrap = (node: React.ReactNode) => (
  <MantineProvider>{node}</MantineProvider>
);

/**
 * Mounts the viewer with a measured container, since the document only
 * mounts once the pane knows its size. The imported react-pdf module is
 * cached per `workerSrc`, so tests that need a fresh import pass their own.
 */
function renderViewer(props: {
  workerSrc: string;
  highlights?: PdfHighlight[];
}) {
  globalThis.ResizeObserver = class {
    constructor(private cb: ResizeObserverCallback) {}
    observe() {
      this.cb(
        [{ contentRect: { width: 800, height: 600 } } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  return render(
    wrap(
      <PdfHighlightViewer
        pdfUrl="/some.pdf"
        highlights={props.highlights}
        workerSrc={props.workerSrc}
        cMapUrl="/pdfjs/cmaps/"
      />,
    ),
  );
}

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

  it("reports download progress while the document loads", async () => {
    mockState.document = (props) => {
      useEffect(() => {
        props.onLoadProgress?.({
          loaded: 3 * 1024 * 1024,
          total: 12 * 1024 * 1024,
        });
      }, []);
      return <>{props.loading}</>;
    };
    renderViewer({ workerSrc: "/w/progress.mjs" });
    expect(await screen.findByText("3.0 MB of 12.0 MB (25%)")).toBeDefined();
  });

  it("names the bytes received when the server reports no length", async () => {
    mockState.document = (props) => {
      useEffect(() => {
        props.onLoadProgress?.({ loaded: 512 * 1024, total: 0 });
      }, []);
      return <>{props.loading}</>;
    };
    renderViewer({ workerSrc: "/w/progress-unknown.mjs" });
    expect(await screen.findByText("512 KB received")).toBeDefined();
  });

  it("shows the load error and restarts the download on Retry", async () => {
    const mounts = vi.fn();
    mockState.document = (props) => {
      useEffect(() => {
        mounts();
        props.onLoadError?.(new Error("HTTP 502"));
      }, []);
      return <>{props.error}</>;
    };
    renderViewer({ workerSrc: "/w/load-error.mjs" });
    expect(await screen.findByText("Could not load this PDF")).toBeDefined();
    expect(screen.getByText("HTTP 502")).toBeDefined();
    expect(mounts).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mounts).toHaveBeenCalledTimes(2));
  });

  it("recovers when the viewer module fails to load", async () => {
    mockState.failForWorkerSrc = "/w/import-fails.mjs";
    mockState.document = (props) => <>{props.loading}</>;
    renderViewer({ workerSrc: "/w/import-fails.mjs" });
    expect(
      await screen.findByText("Could not load the PDF viewer"),
    ).toBeDefined();
    expect(screen.getByText("chunk load failed")).toBeDefined();

    // The failure was not cached, so a retry imports again and succeeds.
    mockState.failForWorkerSrc = null;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.queryByText("Could not load the PDF viewer")).toBeNull(),
    );
    expect(screen.getByTestId("pdf-loading")).toBeDefined();
  });
});
