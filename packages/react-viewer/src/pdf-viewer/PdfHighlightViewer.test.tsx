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
import type { Rotation } from "./geometry";
import type { PdfDocumentLike } from "./text-search";

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
  rotation?: Rotation;
  onRotationChange?: (rotation: Rotation) => void;
  captureFindShortcut?: boolean;
}) {
  return wrap(
    <PdfHighlightViewer
      pdfUrl={props.pdfUrl ?? "/some.pdf"}
      highlights={props.highlights}
      workerSrc={props.workerSrc}
      cMapUrl="/pdfjs/cmaps/"
      onLoadError={props.onLoadError}
      rotation={props.rotation}
      onRotationChange={props.onRotationChange}
      captureFindShortcut={props.captureFindShortcut}
    />,
  );
}

/**
 * Mounts the viewer with a measured container, since the document only
 * mounts once the pane knows its size. The imported react-pdf module is
 * cached per `workerSrc`, so tests that need a fresh import pass their own.
 */
function renderViewer(props: Parameters<typeof viewer>[0]) {
  // happy-dom leaves element scrolling unimplemented.
  Element.prototype.scrollTo ??= vi.fn();
  Element.prototype.scrollIntoView ??= vi.fn();
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

    const rotateLeft = () =>
      fireEvent.click(screen.getByRole("button", { name: "Rotate left" }));
    rotateLeft();
    await waitFor(() => expect(page.dataset.rotate).toBe("270"));
    // A counter-clockwise quarter turn sends (x, y) to (y, SCALE − x): the
    // box now starts at left 200 and top 1000 − 400, with its sides swapped.
    expect(box().left).toBe("20%");
    expect(box().top).toBe("60%");
    expect(box().width).toBe("5%");
    expect(box().height).toBe("30%");

    // Four turns bring the page back upright.
    rotateLeft();
    rotateLeft();
    rotateLeft();
    await waitFor(() => expect(page.dataset.rotate).toBe("0"));
    expect(box().left).toBe("10%");
  });

  /**
   * Document and page mocks for a `pages`-page document whose pages carry
   * the given own rotations; each page renders its rotation, its width and
   * its children, and reports a render once loaded.
   */
  function mountPages(ownRotations: number[], loads = true) {
    mockState.document = (props) => {
      useEffect(() => {
        if (loads) props.onLoadSuccess?.({ numPages: ownRotations.length });
      }, []);
      return loads ? <>{props.children}</> : <>{props.loading}</>;
    };
    mockState.page = (props) => {
      // react-pdf remounts its canvas and fires both callbacks again on
      // every change of rotation or width.
      useEffect(() => {
        props.onLoadSuccess?.({
          view: [0, 0, 600, 800],
          rotate: ownRotations[props.pageNumber - 1] ?? 0,
        });
        props.onRenderSuccess?.();
      }, [props.rotate, props.width]);
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

    fireEvent.click(screen.getByRole("button", { name: "Rotate left" }));
    await waitFor(() => expect(page.dataset.rotate).toBe("0"));
    expect(box().left).toBe("20%");
    expect(box().top).toBe("60%");
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
    fireEvent.click(screen.getByRole("button", { name: "Rotate left" }));
    await waitFor(() => {
      expect(first.dataset.rotate).toBe("270");
      expect(second.dataset.rotate).toBe("0");
    });
  });

  it("refits the page to the container when a turn swaps its sides", async () => {
    // An 800×600 container and a 600×800 page: fit to height gives 450
    // wide upright, and the full 800 once turned.
    mountPages([0]);
    renderViewer({ workerSrc: "/w/fit.mjs" });
    const page = await screen.findByTestId("page-1");
    await waitFor(() => expect(page.dataset.width).toBe("450"));
    fireEvent.click(screen.getByRole("button", { name: "Rotate left" }));
    await waitFor(() => expect(page.dataset.width).toBe("800"));
  });

  it("does not scroll back to the quote on a turn", async () => {
    const original = Element.prototype.scrollTo;
    const scrollTo = vi.fn();
    Element.prototype.scrollTo = scrollTo;
    try {
      mountPages([0]);
      renderViewer({
        workerSrc: "/w/turn-scroll.mjs",
        highlights: [
          {
            bboxes: [{ page: 1, left: 100, top: 200, right: 400, bottom: 250 }],
          },
        ],
      });
      await screen.findByTestId("page-1");
      // The first render scrolls to the quote once.
      await waitFor(() => expect(scrollTo).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByRole("button", { name: "Rotate left" }));
      await waitFor(() =>
        expect(screen.getByTestId("page-1").dataset.rotate).toBe("270"),
      );
      // The page re-reported its load and render for the turn; neither
      // counts as a fresh load, so no second scroll.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(scrollTo).toHaveBeenCalledTimes(1);
    } finally {
      Element.prototype.scrollTo = original;
    }
  });

  it("scrolls to the quote again when a paper is reopened after another never loaded", async () => {
    const original = Element.prototype.scrollTo;
    const scrollTo = vi.fn();
    Element.prototype.scrollTo = scrollTo;
    try {
      const highlights = [
        { bboxes: [{ page: 1, left: 100, top: 200, right: 400, bottom: 250 }] },
      ];
      mountPages([0]);
      const { rerender } = renderViewer({
        workerSrc: "/w/reopen.mjs",
        pdfUrl: "/a.pdf",
        highlights,
      });
      await waitFor(() => expect(scrollTo).toHaveBeenCalledTimes(1));

      // The second paper never gets past loading.
      mountPages([0], false);
      rerender(
        viewer({ workerSrc: "/w/reopen.mjs", pdfUrl: "/b.pdf", highlights }),
      );
      await screen.findByTestId("pdf-loading");

      // Back to the first paper: a fresh load, so its quote is scrolled to
      // once more.
      mountPages([0]);
      rerender(
        viewer({ workerSrc: "/w/reopen.mjs", pdfUrl: "/a.pdf", highlights }),
      );
      await waitFor(() => expect(scrollTo).toHaveBeenCalledTimes(2));
    } finally {
      Element.prototype.scrollTo = original;
    }
  });

  it("follows a controlled rotation and reports turns without applying them itself", async () => {
    const onRotationChange = vi.fn();
    mountPages([0]);
    const { rerender } = renderViewer({
      workerSrc: "/w/controlled.mjs",
      rotation: 90,
      onRotationChange,
      highlights: [
        { bboxes: [{ page: 1, left: 100, top: 200, right: 400, bottom: 250 }] },
      ],
    });
    const page = await screen.findByTestId("page-1");
    await waitFor(() => expect(page.dataset.rotate).toBe("90"));
    // The overlay follows the controlled turn from the first paint.
    const box = () =>
      (page.firstElementChild!.firstElementChild as HTMLElement).style;
    expect(box().left).toBe("75%");

    fireEvent.click(screen.getByRole("button", { name: "Rotate left" }));
    expect(onRotationChange).toHaveBeenCalledWith(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(page.dataset.rotate).toBe("90");

    rerender(
      viewer({
        workerSrc: "/w/controlled.mjs",
        rotation: 180,
        onRotationChange,
        highlights: [
          {
            bboxes: [{ page: 1, left: 100, top: 200, right: 400, bottom: 250 }],
          },
        ],
      }),
    );
    await waitFor(() => expect(page.dataset.rotate).toBe("180"));
  });

  it("resets the turn when another document opens", async () => {
    mountPages([0]);
    const { rerender } = renderViewer({
      workerSrc: "/w/reset-turn.mjs",
      pdfUrl: "/first.pdf",
    });
    await screen.findByTestId("page-1");
    fireEvent.click(screen.getByRole("button", { name: "Rotate left" }));
    await waitFor(() =>
      expect(screen.getByTestId("page-1").dataset.rotate).toBe("270"),
    );
    rerender(viewer({ workerSrc: "/w/reset-turn.mjs", pdfUrl: "/second.pdf" }));
    await waitFor(() =>
      expect(screen.getByTestId("page-1").dataset.rotate).toBe("0"),
    );
  });

  const viewport1000 = {
    width: 1000,
    height: 1000,
    convertToViewportPoint: (x: number, y: number) => [x, 1000 - y],
  };

  /** A one-page document over the given text runs. */
  const docWith = (items: unknown[]): PdfDocumentLike => ({
    numPages: 1,
    getPage: async () => ({
      getTextContent: async () => ({ items }),
      getViewport: () => viewport1000,
    }),
  });

  /** Two runs, the second continuing the first line; "proband" appears in both. A fresh object each call. */
  const twoRunDocument = () =>
    docWith([
      {
        str: "The proband carried",
        transform: [10, 0, 0, 10, 100, 900],
        width: 190,
        height: 10,
        hasEOL: true,
      },
      {
        str: "the variant; the proband's",
        transform: [10, 0, 0, 10, 100, 880],
        width: 260,
        height: 10,
      },
    ]);

  /** Document and page mocks that load `doc` and render its pages with their children. */
  function mountDocument(doc: PdfDocumentLike | null) {
    mockState.document = (props) => {
      useEffect(() => {
        if (doc) props.onLoadSuccess?.(doc);
      }, []);
      return doc ? <>{props.children}</> : <>{props.loading}</>;
    };
    mockState.page = (props) => {
      useEffect(() => {
        props.onLoadSuccess?.({ view: [0, 0, 600, 800], rotate: 0 });
        props.onRenderSuccess?.();
      }, [props.rotate, props.width]);
      return (
        <div data-testid={`page-${props.pageNumber}`}>{props.children}</div>
      );
    };
  }

  const matchBoxes = () =>
    Array.from(
      screen.getByTestId("page-1").firstElementChild?.children ?? [],
    ) as HTMLElement[];

  async function openFind() {
    fireEvent.click(
      await screen.findByRole("button", { name: "Find in document" }),
    );
    return screen.getByLabelText("Search text");
  }

  /** Runs `body` with a spy on element scrolling, restored afterwards. */
  async function withScrollSpy(
    body: (scrollTo: ReturnType<typeof vi.fn>) => Promise<void>,
  ) {
    const original = Element.prototype.scrollTo;
    const scrollTo = vi.fn();
    Element.prototype.scrollTo = scrollTo;
    try {
      await body(scrollTo);
    } finally {
      Element.prototype.scrollTo = original;
    }
  }

  it("finds text in the document and steps through the matches, wrapping at the ends", async () => {
    mountDocument(twoRunDocument());
    renderViewer({ workerSrc: "/w/find.mjs" });
    const input = await openFind();
    fireEvent.change(input, { target: { value: "proband" } });
    expect(await screen.findByText("1 of 2")).toBeDefined();

    // Both matches are drawn, the current one in its own colour and on top.
    // "proband" is characters 4–11 of a 19-character run 190 wide from
    // x=100 on a 1000-wide page, 0.2 em below to 0.8 em above its baseline
    // at y=900: left 14%, top 9.2%.
    expect(matchBoxes().map((b) => b.style.backgroundColor)).toEqual([
      "rgb(180, 210, 255)",
      "rgb(255, 165, 80)",
    ]);
    expect(matchBoxes()[1]!.style.left).toBe("14%");
    expect(matchBoxes()[1]!.style.top).toBe("9.2%");
    expect(matchBoxes()[1]!.style.width).toBe("7%");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("2 of 2")).toBeDefined();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("1 of 2")).toBeDefined();
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(await screen.findByText("2 of 2")).toBeDefined();

    // Match boxes follow a turn like the quote highlights do.
    fireEvent.click(screen.getByRole("button", { name: "Rotate right" }));
    await waitFor(() => expect(matchBoxes()[0]!.style.left).toBe("89.8%"));
    expect(matchBoxes()[0]!.style.top).toBe("14%");

    fireEvent.change(input, { target: { value: "zebra" } });
    expect(await screen.findByText("No matches")).toBeDefined();
    expect(screen.getByTestId("page-1").firstElementChild).toBeNull();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("pdf-find-bar")).toBeNull();
  });

  it("restarts at the first match when the query changes after stepping", async () => {
    await withScrollSpy(async (scrollTo) => {
      mountDocument(twoRunDocument());
      renderViewer({ workerSrc: "/w/find-restart.mjs" });
      const input = await openFind();
      fireEvent.change(input, { target: { value: "proband" } });
      expect(await screen.findByText("1 of 2")).toBeDefined();
      fireEvent.keyDown(input, { key: "Enter" });
      expect(await screen.findByText("2 of 2")).toBeDefined();
      await waitFor(() => expect(scrollTo).toHaveBeenCalledTimes(2));

      // "the" occurs three times; the selection starts over and the view
      // moves once more, to the first of them.
      fireEvent.change(input, { target: { value: "the" } });
      expect(await screen.findByText("1 of 3")).toBeDefined();
      await waitFor(() => expect(scrollTo).toHaveBeenCalledTimes(3));
      const current = matchBoxes().find(
        (b) => b.style.backgroundColor === "rgb(255, 165, 80)",
      )!;
      // The first "the" is on the first line; the second starts at the same
      // x on the line below.
      expect(current.style.left).toBe("10%");
      expect(current.style.top).toBe("9.2%");
    });
  });

  it("drops a pending request when the bar closes before the index lands", async () => {
    await withScrollSpy(async (scrollTo) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const slow = twoRunDocument();
      mountDocument({
        numPages: 1,
        getPage: async () => {
          const page = await slow.getPage(1);
          return {
            ...page,
            getTextContent: async () => {
              await gate;
              return page.getTextContent();
            },
          };
        },
      });
      renderViewer({ workerSrc: "/w/find-close-pending.mjs" });
      const input = await openFind();
      fireEvent.change(input, { target: { value: "proband" } });
      expect(await screen.findByText("Indexing…")).toBeDefined();
      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.queryByTestId("pdf-find-bar")).toBeNull();
      release();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(scrollTo).not.toHaveBeenCalled();
    });
  });

  it("scrolls to the first match of a query typed while the index was still building", async () => {
    await withScrollSpy(async (scrollTo) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const slow = twoRunDocument();
      mountDocument({
        numPages: 1,
        getPage: async () => {
          const page = await slow.getPage(1);
          return {
            ...page,
            getTextContent: async () => {
              await gate;
              return page.getTextContent();
            },
          };
        },
      });
      renderViewer({ workerSrc: "/w/find-slow.mjs" });
      const input = await openFind();
      fireEvent.change(input, { target: { value: "proband" } });
      expect(await screen.findByText("Indexing…")).toBeDefined();
      expect(scrollTo).not.toHaveBeenCalled();
      release();
      expect(await screen.findByText("1 of 2")).toBeDefined();
      await waitFor(() => expect(scrollTo).toHaveBeenCalledTimes(1));
    });
  });

  it("caps the matches it collects and says so", async () => {
    mountDocument(
      docWith([
        {
          str: "x".repeat(1200),
          transform: [10, 0, 0, 10, 0, 500],
          width: 900,
          height: 10,
        },
      ]),
    );
    renderViewer({ workerSrc: "/w/find-cap.mjs" });
    const input = await openFind();
    fireEvent.change(input, { target: { value: "x" } });
    expect(await screen.findByText("1 of 1000+")).toBeDefined();
  });

  it("reports a document without a text layer as text unavailable", async () => {
    mountDocument(docWith([]));
    renderViewer({ workerSrc: "/w/find-scan.mjs" });
    await openFind();
    expect(await screen.findByText("Text unavailable")).toBeDefined();
  });

  it("still searches the readable pages when one page's text cannot be read", async () => {
    mountDocument({
      numPages: 2,
      getPage: async (n: number) => ({
        getTextContent: async () => {
          if (n === 1) throw new Error("corrupt font");
          return {
            items: [
              {
                str: "the proband",
                transform: [10, 0, 0, 10, 100, 900],
                width: 110,
                height: 10,
              },
            ],
          };
        },
        getViewport: () => viewport1000,
      }),
    });
    renderViewer({ workerSrc: "/w/find-partial.mjs" });
    const input = await openFind();
    fireEvent.change(input, { target: { value: "proband" } });
    expect(await screen.findByText("1 of 1")).toBeDefined();
  });

  it("indexes the next document afresh and leaves the view alone for it", async () => {
    await withScrollSpy(async (scrollTo) => {
      mountDocument(twoRunDocument());
      const { rerender } = renderViewer({
        workerSrc: "/w/find-switch.mjs",
        pdfUrl: "/first.pdf",
      });
      const input = await openFind();
      fireEvent.change(input, { target: { value: "proband" } });
      expect(await screen.findByText("1 of 2")).toBeDefined();
      await waitFor(() => expect(scrollTo).toHaveBeenCalledTimes(1));

      // The next document has one match for the same query; it is found and
      // counted, but the view is not moved for it.
      mountDocument(
        docWith([
          {
            str: "one proband",
            transform: [10, 0, 0, 10, 100, 900],
            width: 110,
            height: 10,
          },
        ]),
      );
      rerender(
        viewer({ workerSrc: "/w/find-switch.mjs", pdfUrl: "/second.pdf" }),
      );
      expect(await screen.findByText("1 of 1")).toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(scrollTo).toHaveBeenCalledTimes(1);
    });
  });

  it("rebuilds the index when a paper is reopened after another never loaded", async () => {
    mountDocument(twoRunDocument());
    const { rerender } = renderViewer({
      workerSrc: "/w/find-reopen.mjs",
      pdfUrl: "/a.pdf",
    });
    const input = await openFind();
    fireEvent.change(input, { target: { value: "proband" } });
    expect(await screen.findByText("1 of 2")).toBeDefined();

    mountDocument(null);
    rerender(viewer({ workerSrc: "/w/find-reopen.mjs", pdfUrl: "/b.pdf" }));
    await screen.findByTestId("pdf-loading");

    // A fresh load of the first paper gets a fresh index; this one has a
    // third match, so the old index would show the wrong count.
    mountDocument(
      docWith([
        {
          str: "proband, proband, proband",
          transform: [10, 0, 0, 10, 100, 900],
          width: 250,
          height: 10,
        },
      ]),
    );
    rerender(viewer({ workerSrc: "/w/find-reopen.mjs", pdfUrl: "/a.pdf" }));
    expect(await screen.findByText("1 of 3")).toBeDefined();
  });

  it("moves to the current match when the bar is reopened, and not for a later document", async () => {
    await withScrollSpy(async (scrollTo) => {
      mountDocument(twoRunDocument());
      const { container, rerender } = renderViewer({
        workerSrc: "/w/find-reopen-scroll.mjs",
        pdfUrl: "/a.pdf",
      });
      const input = await openFind();
      fireEvent.change(input, { target: { value: "proband" } });
      expect(await screen.findByText("1 of 2")).toBeDefined();
      await waitFor(() => expect(scrollTo).toHaveBeenCalledTimes(1));

      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.queryByTestId("pdf-find-bar")).toBeNull();
      const root = container.querySelector(".relative")!;
      fireEvent.pointerDown(root, { pointerId: 1 });
      fireEvent.keyDown(document.body, { key: "f", ctrlKey: true });
      expect(screen.getByTestId("pdf-find-bar")).toBeDefined();
      await waitFor(() => expect(scrollTo).toHaveBeenCalledTimes(2));

      // Ctrl+F on the open bar refocuses the box without moving the view.
      fireEvent.keyDown(screen.getByLabelText("Search text"), {
        key: "f",
        ctrlKey: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(scrollTo).toHaveBeenCalledTimes(2);

      mountDocument(twoRunDocument());
      rerender(
        viewer({ workerSrc: "/w/find-reopen-scroll.mjs", pdfUrl: "/b.pdf" }),
      );
      expect(await screen.findByText("1 of 2")).toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(scrollTo).toHaveBeenCalledTimes(2);
    });
  });

  it("takes Ctrl+F with focus in the pane, or on nothing after the pane was last used", () => {
    const { container } = renderViewer({ workerSrc: "/w/shortcut.mjs" });
    const root = container.querySelector(".relative")!;
    const outsideField = document.createElement("textarea");
    const outsideButton = document.createElement("button");
    document.body.append(outsideField, outsideButton);
    try {
      // Nothing has been used yet: the browser keeps its find.
      fireEvent.keyDown(document.body, { key: "f", ctrlKey: true });
      expect(screen.queryByTestId("pdf-find-bar")).toBeNull();
      // Something outside the pane was used last.
      fireEvent.pointerDown(outsideButton, { pointerId: 1 });
      fireEvent.keyDown(document.body, { key: "f", ctrlKey: true });
      expect(screen.queryByTestId("pdf-find-bar")).toBeNull();
      fireEvent.keyDown(outsideField, { key: "f", ctrlKey: true });
      expect(screen.queryByTestId("pdf-find-bar")).toBeNull();
      // The pane was used last; modifiers other than Ctrl or Cmd alone
      // still leave the shortcut to the browser.
      fireEvent.pointerDown(root, { pointerId: 1 });
      fireEvent.keyDown(document.body, {
        key: "f",
        ctrlKey: true,
        shiftKey: true,
      });
      expect(screen.queryByTestId("pdf-find-bar")).toBeNull();
      fireEvent.keyDown(document.body, { key: "f", metaKey: true });
      expect(screen.getByTestId("pdf-find-bar")).toBeDefined();
    } finally {
      outsideField.remove();
      outsideButton.remove();
    }
  });

  it("reads the physical key only when the layout gives no Latin letter", () => {
    const { container } = renderViewer({ workerSrc: "/w/shortcut-layout.mjs" });
    const root = container.querySelector(".relative")!;
    fireEvent.pointerDown(root, { pointerId: 1 });
    // Colemak: the physical F key types "p", and Ctrl+P is print.
    fireEvent.keyDown(document.body, { key: "p", code: "KeyF", ctrlKey: true });
    expect(screen.queryByTestId("pdf-find-bar")).toBeNull();
    // A held key is ignored, and so is a key during composition.
    fireEvent.keyDown(document.body, { key: "f", ctrlKey: true, repeat: true });
    expect(screen.queryByTestId("pdf-find-bar")).toBeNull();
    fireEvent.keyDown(document.body, {
      key: "f",
      ctrlKey: true,
      isComposing: true,
    });
    expect(screen.queryByTestId("pdf-find-bar")).toBeNull();
    // A Cyrillic layout: the same physical key, a non-Latin letter.
    fireEvent.keyDown(document.body, { key: "а", code: "KeyF", ctrlKey: true });
    expect(screen.getByTestId("pdf-find-bar")).toBeDefined();
  });

  it("counts focus landing in the pane as using it", () => {
    const { container } = renderViewer({ workerSrc: "/w/shortcut-focus.mjs" });
    const root = container.querySelector(".relative") as HTMLElement;
    const outsideButton = document.createElement("button");
    document.body.append(outsideButton);
    try {
      fireEvent.pointerDown(outsideButton, { pointerId: 1 });
      fireEvent.focusIn(root);
      fireEvent.keyDown(document.body, { key: "f", ctrlKey: true });
      expect(screen.getByTestId("pdf-find-bar")).toBeDefined();
    } finally {
      outsideButton.remove();
    }
  });

  it("closes on Escape from any control in the bar and hands focus back to the pane", async () => {
    mountDocument(twoRunDocument());
    const { container } = renderViewer({ workerSrc: "/w/escape-button.mjs" });
    await openFind();
    fireEvent.keyDown(screen.getByRole("button", { name: "Close find" }), {
      key: "Escape",
    });
    expect(screen.queryByTestId("pdf-find-bar")).toBeNull();
    expect(document.activeElement).toBe(container.querySelector(".relative"));
  });

  it("takes Ctrl+F from inside the pane regardless of what was used last", () => {
    const { container } = renderViewer({ workerSrc: "/w/shortcut-inside.mjs" });
    const outsideButton = document.createElement("button");
    document.body.append(outsideButton);
    try {
      fireEvent.pointerDown(outsideButton, { pointerId: 1 });
      fireEvent.keyDown(container.querySelector(".relative")!, {
        key: "f",
        ctrlKey: true,
      });
      expect(screen.getByTestId("pdf-find-bar")).toBeDefined();
    } finally {
      outsideButton.remove();
    }
  });

  it("leaves Ctrl+F to the browser when the shortcut is switched off", () => {
    const { container } = renderViewer({
      workerSrc: "/w/no-shortcut.mjs",
      captureFindShortcut: false,
    });
    fireEvent.pointerDown(container.querySelector(".relative")!, {
      pointerId: 1,
    });
    fireEvent.keyDown(document.body, { key: "f", ctrlKey: true });
    expect(screen.queryByTestId("pdf-find-bar")).toBeNull();
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
