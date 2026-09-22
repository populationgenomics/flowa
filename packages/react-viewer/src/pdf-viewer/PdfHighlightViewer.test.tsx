// @vitest-environment happy-dom

import { useEffect } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { PdfHighlightViewer } from "./PdfHighlightViewer";
import type { PdfHighlight } from "./types";

type DocumentProps = {
  file?: unknown;
  loading?: React.ReactNode;
  error?: React.ReactNode;
  onLoadProgress?(p: { loaded: number; total: number }): void;
  onLoadError?(e: Error): void;
  onSourceError?(e: Error): void;
};

/**
 * react-pdf is mocked so no pdf.js worker loads in the test environment. The
 * mock is one hoisted module whose `Document` delegates to whatever a test
 * put in `mockState`, so each test shapes the document's behaviour without
 * re-registering the mock. The mocker evaluates the factory once, so a failed
 * import cannot be staged there; `failForWorkerSrc` instead makes the worker
 * configuration throw for one `workerSrc`, which rejects the same promise a
 * chunk that did not download would. `workerSrcSets` records every import
 * that got as far as configuring the worker.
 */
const mockState = vi.hoisted(() => ({
  document: null as null | ((props: DocumentProps) => React.ReactNode),
  failForWorkerSrc: null as string | null,
  workerSrcSets: [] as string[],
}));

vi.mock("react-pdf", () => ({
  pdfjs: {
    GlobalWorkerOptions: {
      set workerSrc(value: string) {
        mockState.workerSrcSets.push(value);
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
  mockState.workerSrcSets = [];
});

const wrap = (node: React.ReactNode) => (
  <MantineProvider>{node}</MantineProvider>
);

function viewer(props: {
  workerSrc: string;
  pdfUrl?: string;
  highlights?: PdfHighlight[];
}) {
  return wrap(
    <PdfHighlightViewer
      pdfUrl={props.pdfUrl ?? "/some.pdf"}
      highlights={props.highlights}
      workerSrc={props.workerSrc}
      cMapUrl="/pdfjs/cmaps/"
    />,
  );
}

/**
 * Mounts the viewer with a measured container, since the document only
 * mounts once the pane knows its size. The imported react-pdf module is
 * cached per `workerSrc`, so tests that need a fresh import pass their own.
 */
function renderViewer(props: Parameters<typeof viewer>[0]) {
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
  return render(viewer(props));
}

const MB = 1024 * 1024;

/** A document that reports one progress event on mount and shows the loading slot. */
function reportingProgress(loaded: number, total: number) {
  mockState.document = (props) => {
    useEffect(() => {
      props.onLoadProgress?.({ loaded, total });
    }, []);
    return <>{props.loading}</>;
  };
}

describe("PdfHighlightViewer", () => {
  it("renders the loading state before react-pdf resolves", () => {
    const { container } = render(
      viewer({ workerSrc: "/pdfjs/pdf.worker.min.mjs" }),
    );
    // Loader from @mantine/core renders a span with role="presentation"
    // (or a div). Look for the wrapping container plus absence of error.
    expect(container.querySelector(".relative")).not.toBeNull();
  });

  it("surfaces a not-found alert when a highlight has no bboxes but a label", () => {
    render(
      viewer({
        workerSrc: "/pdfjs/pdf.worker.min.mjs",
        highlights: [
          { bboxes: [], label: "the quote that could not be located" },
        ],
      }),
    );
    expect(screen.getByText(/Could not locate quote/)).toBeDefined();
    expect(
      screen.getByText(/the quote that could not be located/),
    ).toBeDefined();
  });

  it("shows a locating state for a pending highlight, not the not-found warning", () => {
    render(
      viewer({
        workerSrc: "/pdfjs/pdf.worker.min.mjs",
        highlights: [
          { bboxes: [], label: "a quote still being resolved", pending: true },
        ],
      }),
    );
    expect(screen.getByText(/Locating quote/)).toBeDefined();
    expect(screen.getByText(/a quote still being resolved/)).toBeDefined();
    expect(screen.queryByText(/Could not locate quote/)).toBeNull();
  });

  it("reports download progress while the document loads", async () => {
    reportingProgress(3 * MB, 12 * MB);
    renderViewer({ workerSrc: "/w/progress.mjs" });
    expect(await screen.findByText("3.0 MB of 12.0 MB (25%)")).toBeDefined();
  });

  it("names the bytes received when the server reports no length", async () => {
    // pdf.js leaves `total` undefined without a Content-Length.
    reportingProgress(512 * 1024, undefined as unknown as number);
    renderViewer({ workerSrc: "/w/progress-unknown.mjs" });
    expect(await screen.findByText("512 KB received")).toBeDefined();
  });

  it("caps the percentage when more arrives than was announced", async () => {
    reportingProgress(13 * MB, 12 * MB);
    renderViewer({ workerSrc: "/w/progress-over.mjs" });
    expect(await screen.findByText("13.0 MB of 12.0 MB (100%)")).toBeDefined();
  });

  it("shows the load error, then a fresh download on Retry", async () => {
    const mounts = vi.fn();
    mockState.document = (props) => {
      useEffect(() => {
        mounts();
        // Only the first download fails; the retry loads.
        if (mounts.mock.calls.length === 1)
          props.onLoadError?.(new Error("HTTP 502"));
      }, []);
      return <>{props.loading}</>;
    };
    renderViewer({ workerSrc: "/w/load-error.mjs" });
    expect(await screen.findByText("Could not load this PDF")).toBeDefined();
    expect(screen.getByText("HTTP 502")).toBeDefined();
    expect(mounts).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mounts).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Could not load this PDF")).toBeNull();
    expect(screen.getByTestId("pdf-loading")).toBeDefined();
  });

  it("names the cause rather than the URL for a pdf.js response error", async () => {
    mockState.document = (props) => {
      useEffect(() => {
        props.onLoadError?.(
          Object.assign(
            new Error(
              'Unexpected server response (403) while retrieving PDF "https://bucket.example/paper.pdf?X-Amz-Signature=abc".',
            ),
            { name: "UnexpectedResponseException", status: 403 },
          ),
        );
      }, []);
      return <>{props.loading}</>;
    };
    renderViewer({ workerSrc: "/w/load-403.mjs" });
    const line = await screen.findByText(
      "The server answered with status 403.",
    );
    expect(line.getAttribute("title")).toContain("X-Amz-Signature");
  });

  it("shows the failure for a source that cannot be read at all", async () => {
    // react-pdf renders its loading slot, not its error slot, after a
    // source error, so the failure has to be decided outside it.
    mockState.document = (props) => {
      useEffect(() => {
        props.onSourceError?.(new Error("bad data URI"));
      }, []);
      return <>{props.loading}</>;
    };
    renderViewer({ workerSrc: "/w/source-error.mjs" });
    expect(await screen.findByText("Could not load this PDF")).toBeDefined();
    expect(screen.getByText("bad data URI")).toBeDefined();
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
  });

  it("keeps a superseded download's progress out of the next document", async () => {
    // react-pdf lets a superseded download run on and keeps reporting to
    // the callbacks it was given; those reports must not reach the state
    // of the document that replaced it.
    const progressFor: Record<string, DocumentProps["onLoadProgress"]> = {};
    const initial: Record<string, [number, number]> = {
      "/a.pdf": [4 * MB, 12 * MB],
      "/b.pdf": [1.6 * MB, 4 * MB],
    };
    mockState.document = (props) => {
      const file = props.file as string;
      progressFor[file] = props.onLoadProgress;
      useEffect(() => {
        const [loaded, total] = initial[file]!;
        props.onLoadProgress?.({ loaded, total });
      }, []);
      return <>{props.loading}</>;
    };
    const { rerender } = renderViewer({
      workerSrc: "/w/supersede.mjs",
      pdfUrl: "/a.pdf",
    });
    expect(await screen.findByText("4.0 MB of 12.0 MB (33%)")).toBeDefined();

    rerender(viewer({ workerSrc: "/w/supersede.mjs", pdfUrl: "/b.pdf" }));
    expect(await screen.findByText("1.6 MB of 4.0 MB (40%)")).toBeDefined();

    // The first document's download completes after it was replaced.
    progressFor["/a.pdf"]?.({ loaded: 12 * MB, total: 12 * MB });
    expect(screen.getByText("1.6 MB of 4.0 MB (40%)")).toBeDefined();
    expect(screen.queryByText(/12.0 MB/)).toBeNull();
  });

  it("recovers when the viewer module fails to load", async () => {
    mockState.failForWorkerSrc = "/w/import-fails.mjs";
    mockState.document = (props) => (
      <div data-testid="mock-document">{props.loading}</div>
    );
    renderViewer({ workerSrc: "/w/import-fails.mjs" });
    expect(
      await screen.findByText("Could not load the PDF viewer"),
    ).toBeDefined();
    expect(screen.getByText("chunk load failed")).toBeDefined();
    expect(screen.queryByTestId("mock-document")).toBeNull();

    // The failure was not cached, so a retry imports again and the
    // document mounts.
    mockState.failForWorkerSrc = null;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("mock-document")).toBeDefined();
    expect(
      mockState.workerSrcSets.filter((s) => s === "/w/import-fails.mjs"),
    ).toHaveLength(2);
  });
});
