// @vitest-environment happy-dom

import { useEffect } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import {
  PdfHighlightViewer,
  classifyLoadError,
  describeLoadError,
} from "./PdfHighlightViewer";
import type { PdfHighlight } from "./types";

type DocumentProps = {
  file?: unknown;
  children?: React.ReactNode;
  loading?: React.ReactNode;
  error?: React.ReactNode;
  onLoadSuccess?(d: { numPages: number }): void;
  onLoadProgress?(p: { loaded: number; total: number }): void;
  onLoadError?(e: Error): void;
  onSourceError?(e: Error): void;
  onPassword?(callback: (value: unknown) => void, reason: number): void;
};

type PageProps = {
  pageNumber: number;
  rotate?: number;
  children?: React.ReactNode;
  width?: number;
  onLoadSuccess?(p: { view: number[]; rotate: number }): void;
  onRenderSuccess?(): void;
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
  page: null as null | ((props: PageProps) => React.ReactNode),
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
  Page: (props: PageProps) => (mockState.page ? mockState.page(props) : null),
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
  mockState.page = null;
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
  onLoadError?: (error: Error, info: unknown) => void;
}) {
  return wrap(
    <PdfHighlightViewer
      pdfUrl={props.pdfUrl ?? "/some.pdf"}
      highlights={props.highlights}
      workerSrc={props.workerSrc}
      cMapUrl="/pdfjs/cmaps/"
      onLoadError={props.onLoadError}
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
    render(viewer({ workerSrc: "/pdfjs/pdf.worker.min.mjs" }));
    expect(screen.getByTestId("pdf-loading")).toBeDefined();
    expect(screen.queryByTestId("pdf-load-error")).toBeNull();
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

  it("never shows more received than was announced", async () => {
    // In range mode pdf.js counts whole chunks, so `loaded` can pass `total`.
    reportingProgress(13 * MB, 12 * MB);
    renderViewer({ workerSrc: "/w/progress-over.mjs" });
    expect(await screen.findByText("12.0 MB of 12.0 MB (100%)")).toBeDefined();
  });

  it("treats a zero total as unknown", async () => {
    reportingProgress(512 * 1024, 0);
    renderViewer({ workerSrc: "/w/progress-zero.mjs" });
    expect(await screen.findByText("512 KB received")).toBeDefined();
  });

  it("treats an unparseable total as unknown", async () => {
    reportingProgress(256 * 1024, Number.NaN);
    renderViewer({ workerSrc: "/w/progress-nan.mjs" });
    expect(await screen.findByText("256 KB received")).toBeDefined();
  });

  it("rounds a count just under a megabyte as one", async () => {
    reportingProgress(1023.5 * 1024, 2 * MB);
    renderViewer({ workerSrc: "/w/progress-boundary.mjs" });
    expect(await screen.findByText("1.0 MB of 2.0 MB (50%)")).toBeDefined();
  });

  it("offers Retry once a download has gone quiet", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockState.document = (props) => <>{props.loading}</>;
      renderViewer({ workerSrc: "/w/stall.mjs" });
      await screen.findByTestId("pdf-loading");
      expect(screen.queryByText("Still waiting for the server.")).toBeNull();
      act(() => {
        vi.advanceTimersByTime(15_000);
      });
      expect(screen.getByText("Still waiting for the server.")).toBeDefined();
      expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports progress again after a Retry that follows a load", async () => {
    // A load that resolves and then fails leaves the loaded flag set; Retry
    // must clear it or the next download shows a bare spinner.
    const mounts = vi.fn();
    mockState.document = (props) => {
      useEffect(() => {
        mounts();
        if (mounts.mock.calls.length === 1) {
          props.onLoadSuccess?.({ numPages: 1 });
          props.onLoadError?.(new Error("lost the connection"));
        } else {
          props.onLoadProgress?.({ loaded: 3 * MB, total: 12 * MB });
        }
      }, []);
      return <>{props.loading}</>;
    };
    renderViewer({ workerSrc: "/w/retry-after-load.mjs" });
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText("3.0 MB of 12.0 MB (25%)")).toBeDefined();
  });

  it("puts its own loading state in react-pdf's error slot", async () => {
    mockState.document = (props) => <>{props.error}</>;
    renderViewer({ workerSrc: "/w/error-slot.mjs" });
    expect(await screen.findByTestId("pdf-loading")).toBeDefined();
    expect(screen.queryByText(/Failed to load/)).toBeNull();
  });

  it("rejects the password prompt so an encrypted file fails as such", async () => {
    let passwordAnswer: unknown;
    mockState.document = (props) => {
      useEffect(() => {
        props.onPassword?.((value) => {
          passwordAnswer = value;
        }, 1);
        props.onLoadError?.(
          Object.assign(new Error("No password given"), {
            name: "PasswordException",
          }),
        );
      }, []);
      return <>{props.loading}</>;
    };
    renderViewer({ workerSrc: "/w/password.mjs" });
    expect(
      await screen.findByText("The PDF is password protected."),
    ).toBeDefined();
    expect(passwordAnswer).toBeInstanceOf(Error);
  });

  it("ignores progress once the document has loaded", async () => {
    mockState.document = (props) => {
      useEffect(() => {
        props.onLoadSuccess?.({ numPages: 1 });
        props.onLoadProgress?.({ loaded: 3 * MB, total: 12 * MB });
      }, []);
      return <>{props.loading}</>;
    };
    renderViewer({ workerSrc: "/w/progress-after-load.mjs" });
    await screen.findByTestId("pdf-loading");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText(/12.0 MB/)).toBeNull();
  });

  it("tells the consumer about a load failure, classified", async () => {
    const onLoadError = vi.fn();
    mockState.document = (props) => {
      useEffect(() => {
        props.onLoadError?.(
          Object.assign(new Error("Unexpected server response (403)"), {
            name: "UnexpectedResponseException",
            status: 403,
          }),
        );
      }, []);
      return <>{props.loading}</>;
    };
    renderViewer({ workerSrc: "/w/load-error-callback.mjs", onLoadError });
    await screen.findByText("Could not load this PDF");
    expect(onLoadError).toHaveBeenCalledTimes(1);
    expect(onLoadError.mock.calls[0]![0]).toMatchObject({
      message: "Unexpected server response (403)",
    });
    expect(onLoadError.mock.calls[0]![1]).toEqual({
      kind: "http",
      status: 403,
    });
  });

  it("lets a press on Retry through instead of starting a drag", async () => {
    const originalSet = Element.prototype.setPointerCapture;
    const originalRelease = Element.prototype.releasePointerCapture;
    const setPointerCapture = vi.fn();
    Element.prototype.setPointerCapture = setPointerCapture;
    Element.prototype.releasePointerCapture ??= vi.fn();
    try {
      mockState.document = (props) => {
        useEffect(() => {
          props.onLoadError?.(new Error("HTTP 502"));
        }, []);
        return <>{props.loading}</>;
      };
      const { container } = renderViewer({ workerSrc: "/w/retry-press.mjs" });
      const retry = await screen.findByRole("button", { name: "Retry" });
      fireEvent.pointerDown(retry, { pointerId: 1, clientX: 10, clientY: 10 });
      expect(setPointerCapture).not.toHaveBeenCalled();
      fireEvent.pointerDown(container.querySelector(".overflow-auto")!, {
        pointerId: 1,
        clientX: 10,
        clientY: 10,
      });
      expect(setPointerCapture).toHaveBeenCalledTimes(1);
    } finally {
      Element.prototype.setPointerCapture = originalSet;
      Element.prototype.releasePointerCapture = originalRelease;
    }
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

    // The first document's download completes after it was replaced. Inside
    // act, so a state update that did land would be flushed before the read.
    act(() => {
      progressFor["/a.pdf"]?.({ loaded: 12 * MB, total: 12 * MB });
    });
    expect(screen.getByText("1.6 MB of 4.0 MB (40%)")).toBeDefined();
    expect(screen.queryByText(/12.0 MB/)).toBeNull();
  });

  it("turns the page and its highlights together", async () => {
    mockState.document = (props) => {
      useEffect(() => {
        props.onLoadSuccess?.({ numPages: 1 });
      }, []);
      return <>{props.children}</>;
    };
    mockState.page = (props) => {
      useEffect(() => {
        props.onLoadSuccess?.({ view: [0, 0, 600, 800], rotate: 0 });
      }, []);
      return (
        <div data-testid="page" data-rotate={props.rotate ?? "none"}>
          {props.children}
        </div>
      );
    };
    renderViewer({
      workerSrc: "/w/rotate.mjs",
      highlights: [
        { bboxes: [{ page: 1, left: 100, top: 200, right: 400, bottom: 250 }] },
      ],
    });
    const page = await screen.findByTestId("page");
    await waitFor(() => expect(page.dataset.rotate).toBe("0"));
    // The overlay wraps one div per bbox.
    const box = () =>
      (page.firstElementChild!.firstElementChild as HTMLElement).style;
    expect(box().left).toBe("10%");
    expect(box().top).toBe("20%");

    fireEvent.click(screen.getByRole("button", { name: "Rotate right" }));
    await waitFor(() => expect(page.dataset.rotate).toBe("90"));
    // A clockwise quarter turn sends (x, y) to (SCALE − y, x): the box now
    // starts at left 1000 − 250 and top 100, with its sides swapped.
    expect(box().left).toBe("75%");
    expect(box().top).toBe("10%");
    expect(box().width).toBe("5%");
    expect(box().height).toBe("30%");

    fireEvent.click(screen.getByRole("button", { name: "Rotate left" }));
    await waitFor(() => expect(page.dataset.rotate).toBe("0"));
    expect(box().left).toBe("10%");
  });

  /**
   * Document and page mocks for a `pages`-page document whose pages carry
   * the given own rotations; each page renders its rotation, its width and
   * its children, and reports a render once loaded.
   */
  function mountPages(ownRotations: number[]) {
    mockState.document = (props) => {
      useEffect(() => {
        props.onLoadSuccess?.({ numPages: ownRotations.length });
      }, []);
      return <>{props.children}</>;
    };
    mockState.page = (props) => {
      useEffect(() => {
        props.onLoadSuccess?.({
          view: [0, 0, 600, 800],
          rotate: ownRotations[props.pageNumber - 1] ?? 0,
        });
        props.onRenderSuccess?.();
      }, []);
      return (
        <div
          data-testid={`page-${props.pageNumber}`}
          data-rotate={props.rotate ?? "none"}
          data-width={props.width ?? "none"}
        >
          {props.children}
        </div>
      );
    };
  }

  it("keeps a page's own rotation and turns from there", async () => {
    mountPages([90]);
    renderViewer({
      workerSrc: "/w/own-rotation.mjs",
      highlights: [
        { bboxes: [{ page: 1, left: 100, top: 200, right: 400, bottom: 250 }] },
      ],
    });
    const page = await screen.findByTestId("page-1");
    await waitFor(() => expect(page.dataset.rotate).toBe("90"));
    // The quote's box is in the page's own frame, so it does not move for
    // the page's own rotation, only for the user's turn.
    const box = () =>
      (page.firstElementChild!.firstElementChild as HTMLElement).style;
    expect(box().left).toBe("10%");
    expect(box().top).toBe("20%");

    fireEvent.click(screen.getByRole("button", { name: "Rotate right" }));
    await waitFor(() => expect(page.dataset.rotate).toBe("180"));
    expect(box().left).toBe("75%");
    expect(box().top).toBe("10%");
  });

  it("gives each page its own rotation plus the turn", async () => {
    mountPages([0, 90]);
    renderViewer({ workerSrc: "/w/mixed-rotation.mjs" });
    const first = await screen.findByTestId("page-1");
    const second = await screen.findByTestId("page-2");
    await waitFor(() => {
      expect(first.dataset.rotate).toBe("0");
      expect(second.dataset.rotate).toBe("90");
    });
    fireEvent.click(screen.getByRole("button", { name: "Rotate right" }));
    await waitFor(() => {
      expect(first.dataset.rotate).toBe("90");
      expect(second.dataset.rotate).toBe("180");
    });
  });

  it("refits the page to the container when a turn swaps its sides", async () => {
    // An 800×600 container and a 600×800 page: fit to height gives 450
    // wide upright, and the full 800 once turned.
    mountPages([0]);
    renderViewer({ workerSrc: "/w/fit.mjs" });
    const page = await screen.findByTestId("page-1");
    await waitFor(() => expect(page.dataset.width).toBe("450"));
    fireEvent.click(screen.getByRole("button", { name: "Rotate right" }));
    await waitFor(() => expect(page.dataset.width).toBe("800"));
  });

  it("does not scroll back to the quote on a turn", async () => {
    const scrollTo = vi.fn();
    Element.prototype.scrollTo = scrollTo;
    mountPages([0]);
    renderViewer({
      workerSrc: "/w/turn-scroll.mjs",
      highlights: [
        { bboxes: [{ page: 1, left: 100, top: 200, right: 400, bottom: 250 }] },
      ],
    });
    await screen.findByTestId("page-1");
    // The first render scrolls to the quote once.
    await waitFor(() => expect(scrollTo).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Rotate right" }));
    await waitFor(() =>
      expect(screen.getByTestId("page-1").dataset.rotate).toBe("90"),
    );
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("resets the turn when another document opens", async () => {
    mountPages([0]);
    const { rerender } = renderViewer({
      workerSrc: "/w/reset-turn.mjs",
      pdfUrl: "/first.pdf",
    });
    await screen.findByTestId("page-1");
    fireEvent.click(screen.getByRole("button", { name: "Rotate right" }));
    await waitFor(() =>
      expect(screen.getByTestId("page-1").dataset.rotate).toBe("90"),
    );
    rerender(viewer({ workerSrc: "/w/reset-turn.mjs", pdfUrl: "/second.pdf" }));
    await waitFor(() =>
      expect(screen.getByTestId("page-1").dataset.rotate).toBe("0"),
    );
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

describe("describeLoadError", () => {
  const named = (name: string, message = "raw", extra: object = {}) =>
    Object.assign(new Error(message), { name }, extra);

  it("names each pdf.js failure in a line without the URL", () => {
    expect(describeLoadError(named("MissingPDFException"))).toBe(
      "The file was not found on the server.",
    );
    expect(
      describeLoadError(
        named("UnexpectedResponseException", "raw", { status: 403 }),
      ),
    ).toBe("The server answered with status 403.");
    expect(describeLoadError(named("UnexpectedResponseException"))).toBe(
      "The server answered unexpectedly.",
    );
    expect(describeLoadError(named("InvalidPDFException"))).toBe(
      "The file is not a valid PDF.",
    );
    expect(describeLoadError(named("PasswordException"))).toBe(
      "The PDF is password protected.",
    );
    expect(describeLoadError(named("AbortException"))).toBe(
      "The download was interrupted.",
    );
  });

  it("recognises a fetch that never got a response, and not a parser crash", () => {
    expect(
      describeLoadError(
        named("UnknownErrorException", "Failed to fetch", {
          details: "TypeError: Failed to fetch",
        }),
      ),
    ).toBe("The download failed: a network or CORS error.");
    // A TypeError thrown inside the worker's parser is wrapped the same way.
    const crash = named(
      "UnknownErrorException",
      "Cannot read properties of undefined (reading 'x')",
      {
        details: "TypeError: Cannot read properties of undefined (reading 'x')",
      },
    );
    expect(describeLoadError(crash)).toBe(
      "Cannot read properties of undefined (reading 'x')",
    );
    expect(classifyLoadError(crash)).toEqual({ kind: "unknown" });
    expect(describeLoadError(named("UnknownErrorException", "odd"))).toBe(
      "odd",
    );
  });

  it("classifies each failure for the consumer", () => {
    expect(classifyLoadError(named("MissingPDFException"))).toEqual({
      kind: "not-found",
    });
    expect(
      classifyLoadError(
        named("UnexpectedResponseException", "raw", { status: 403 }),
      ),
    ).toEqual({ kind: "http", status: 403 });
    expect(classifyLoadError(named("PasswordException"))).toEqual({
      kind: "password",
    });
    expect(classifyLoadError(new Error("chunk load failed"))).toEqual({
      kind: "unknown",
    });
  });

  it("falls back to the message, or a placeholder for none", () => {
    expect(describeLoadError(new Error("chunk load failed"))).toBe(
      "chunk load failed",
    );
    expect(describeLoadError(new Error(""))).toBe("Unknown error");
  });
});
