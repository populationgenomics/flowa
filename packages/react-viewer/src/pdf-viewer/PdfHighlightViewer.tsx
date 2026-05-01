import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ActionIcon, Alert, Loader } from "@mantine/core";
import {
  IconAlertTriangle,
  IconZoomIn,
  IconZoomOut,
} from "@tabler/icons-react";
import type { HighlightBbox, PdfHighlight } from "./types";

export interface PdfHighlightViewerProps {
  /** URL of the PDF to display (presigned, blob:, or any fetchable URL). */
  pdfUrl: string;
  /** Highlights to render as colored overlays. */
  highlights?: PdfHighlight[];
  /** Page to scroll to on mount (1-indexed). Used as fallback when no highlights are provided. */
  initialPage?: number;
  /** Controlled zoom level. When provided, overrides internal state. */
  zoom?: number;
  /** Called when the user changes zoom via the built-in controls. */
  onZoomChange?: (zoom: number) => void;
  /** URL of pdf.js worker (`pdf.worker.min.mjs`), served by the consumer. */
  workerSrc: string;
  /** URL prefix for pdf.js cmaps (e.g. `/pdfjs/cmaps/`), served by the consumer. */
  cMapUrl: string;
}

/** Reference scale used by the pipeline (0–1000 normalized coordinates). */
const SCALE = 1000;

type ReactPdfModule = typeof import("react-pdf");

let cached: { promise: Promise<ReactPdfModule>; workerSrc: string } | null =
  null;

/**
 * Lazily import `react-pdf` and configure the global pdf.js worker. Cached
 * across all viewer instances; re-runs only if `workerSrc` changes (rare).
 *
 * Done as a dynamic import so consumers don't pay for pdf.js in their server
 * bundle, and so the package is SSR-safe without requiring callers to wrap
 * the component in `dynamic({ ssr: false })`.
 */
function loadReactPdf(workerSrc: string): Promise<ReactPdfModule> {
  if (!cached || cached.workerSrc !== workerSrc) {
    const promise = import("react-pdf").then((mod) => {
      mod.pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
      return mod;
    });
    cached = { promise, workerSrc };
  }
  return cached.promise;
}

function useReactPdf(workerSrc: string): ReactPdfModule | null {
  const [mod, setMod] = useState<ReactPdfModule | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadReactPdf(workerSrc).then((m) => {
      if (!cancelled) setMod(m);
    });
    return () => {
      cancelled = true;
    };
  }, [workerSrc]);
  return mod;
}

/** Render bbox highlights for a page as a single overlay (non-multiplicative). */
function HighlightOverlay({ bboxes }: { bboxes: HighlightBbox[] }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: 4,
        mixBlendMode: "multiply",
      }}
    >
      {bboxes.map((bbox, j) => (
        <div
          key={j}
          style={{
            position: "absolute",
            left: `${(bbox.left / SCALE) * 100}%`,
            top: `${(bbox.top / SCALE) * 100}%`,
            width: `${((bbox.right - bbox.left) / SCALE) * 100}%`,
            height: `${((bbox.bottom - bbox.top) / SCALE) * 100}%`,
            backgroundColor: "rgb(255, 210, 90)",
          }}
        />
      ))}
    </div>
  );
}

/**
 * Reusable PDF viewer with bbox highlight overlays.
 *
 * Renders a PDF using react-pdf and overlays colored rectangles at the specified
 * coordinates. On mount, scrolls to the first highlight's page (if any), or to
 * `initialPage` as a fallback.
 *
 * Default sizing fits one full page within the viewport. Zoom in/out buttons
 * adjust from there.
 */
export const PdfHighlightViewer = ({
  pdfUrl,
  highlights,
  initialPage,
  zoom: externalZoom,
  onZoomChange,
  workerSrc,
  cMapUrl,
}: PdfHighlightViewerProps) => {
  const reactPdf = useReactPdf(workerSrc);

  const [numPages, setNumPages] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const targetPageRef = useRef<HTMLDivElement>(null);
  const hasScrolledRef = useRef(false);
  const dragRef = useRef({
    isDragging: false,
    startX: 0,
    startY: 0,
    scrollLeft: 0,
    scrollTop: 0,
  });
  const [containerSize, setContainerSize] = useState<{
    width: number;
    height: number;
  } | null>(null);

  // Aspect ratio of the first page (width / height in PDF points)
  const [pageAspectRatio, setPageAspectRatio] = useState<number | null>(null);
  const [ownZoom, setOwnZoom] = useState(1);
  const zoom = externalZoom ?? ownZoom;
  /**
   * Scroll position to restore after a zoom-driven re-layout, captured as a
   * fraction of total scrollable height before the zoom takes effect. A
   * naive scrollTop preservation wouldn't work: pages resize, so the same
   * numeric scrollTop points at different content post-zoom. The ratio is
   * the cleanest approximation — after re-layout we set scrollTop =
   * newScrollHeight * ratio, and the user stays on roughly the same part
   * of the document. Consumed in a useLayoutEffect that fires on pageWidth
   * change.
   */
  const pendingScrollRatio = useRef<number | null>(null);
  const setZoom = useCallback(
    (next: number) => {
      const container = containerRef.current;
      if (container && container.scrollHeight > 0) {
        pendingScrollRatio.current =
          container.scrollTop / container.scrollHeight;
      }
      setOwnZoom(next);
      onZoomChange?.(next);
    },
    [onZoomChange],
  );

  // Detect highlights that couldn't be resolved (requested but no bboxes)
  const unresolvedQuotes = useMemo(() => {
    if (!highlights) return [];
    return highlights
      .filter((h) => h.bboxes.length === 0 && h.label)
      .map((h) => h.label!);
  }, [highlights]);

  // Group highlights by page number (1-indexed, matching PDF conventions)
  const highlightsByPage = useMemo(() => {
    const map = new Map<number, HighlightBbox[]>();
    for (const h of highlights ?? []) {
      for (const bbox of h.bboxes) {
        const pageNum = bbox.page;
        const list = map.get(pageNum) ?? [];
        list.push(bbox);
        map.set(pageNum, list);
      }
    }
    return map;
  }, [highlights]);

  // Determine target page for initial scroll
  const targetPage = useMemo(() => {
    for (const h of highlights ?? []) {
      if (h.bboxes.length > 0) return h.bboxes[0]!.page;
    }
    return initialPage ?? 1;
  }, [highlights, initialPage]);

  // Memoize Document options to prevent unnecessary reloads
  const documentOptions = useMemo(
    () =>
      reactPdf
        ? {
            cMapUrl,
            cMapPacked: true,
          }
        : undefined,
    [reactPdf, cMapUrl],
  );

  // Measure container dimensions
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry)
        setContainerSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Capture first page's aspect ratio for sizing calculations
  const handleFirstPageLoad = useCallback(
    (page: { originalWidth: number; originalHeight: number }) => {
      if (pageAspectRatio === null) {
        setPageAspectRatio(page.originalWidth / page.originalHeight);
      }
    },
    [pageAspectRatio],
  );

  // Compute page render width: fit one full page in the viewport, then apply zoom
  const pageWidth = useMemo(() => {
    if (!containerSize || !pageAspectRatio) return undefined;
    const fitHeightWidth = containerSize.height * pageAspectRatio;
    const baseWidth = Math.min(fitHeightWidth, containerSize.width);
    return baseWidth * zoom;
  }, [containerSize, pageAspectRatio, zoom]);

  // First bbox on the target page (for sub-page scroll positioning)
  const firstBbox = useMemo(() => {
    for (const h of highlights ?? []) {
      if (h.bboxes.length > 0) return h.bboxes[0]!;
    }
    return undefined;
  }, [highlights]);

  // Scroll the container so the target highlight is visible
  const scrollToHighlight = useCallback(() => {
    const pageDiv = targetPageRef.current;
    const container = containerRef.current;
    if (!pageDiv || !container) return;

    if (firstBbox) {
      const pageHeight = pageDiv.offsetHeight;
      const bboxTop = (firstBbox.top / SCALE) * pageHeight;
      const bboxBottom = (firstBbox.bottom / SCALE) * pageHeight;
      const bboxCenter = pageDiv.offsetTop + (bboxTop + bboxBottom) / 2;
      const scrollTarget = bboxCenter - container.clientHeight / 3;
      container.scrollTo({ top: Math.max(0, scrollTarget) });
    } else {
      pageDiv.scrollIntoView({ block: "start" });
    }
  }, [firstBbox]);

  // Scroll to the bbox location after the target page's canvas has rendered
  const handlePageRenderSuccess = useCallback(
    (pageNum: number) => {
      if (pageNum !== targetPage || hasScrolledRef.current) return;
      hasScrolledRef.current = true;
      scrollToHighlight();
    },
    [targetPage, scrollToHighlight],
  );

  // Reset state when PDF URL changes (zoom intentionally preserved).
  // Must be defined before the re-scroll effect so hasScrolledRef is reset
  // before the re-scroll guard checks it.
  useEffect(() => {
    setNumPages(null);
    setPageAspectRatio(null);
    hasScrolledRef.current = false;
  }, [pdfUrl]);

  // Re-scroll when highlights change (claim navigation within the same PDF).
  // Skips initial load (hasScrolledRef is false) and PDF URL changes (which
  // reset hasScrolledRef) — both are handled by handlePageRenderSuccess.
  useEffect(() => {
    if (!hasScrolledRef.current) return;
    scrollToHighlight();
  }, [targetPage, firstBbox, scrollToHighlight]);

  // Restore scroll position proportionally after a zoom-driven re-layout.
  // Runs on every pageWidth change; the guard on pendingScrollRatio.current
  // ensures it only fires when a zoom actually triggered it (not on initial
  // load or container resize). Uses useLayoutEffect so the scroll jump is
  // applied before the browser paints — users don't see the flash to top.
  // A rAF-delayed second application catches the case where react-pdf's
  // canvases are still resizing when the first attempt ran; by the next
  // frame, scrollHeight reflects the final layout.
  useLayoutEffect(() => {
    const ratio = pendingScrollRatio.current;
    if (ratio === null) return;
    const container = containerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight * ratio;
    const raf = requestAnimationFrame(() => {
      if (!containerRef.current) return;
      containerRef.current.scrollTop =
        containerRef.current.scrollHeight * ratio;
      pendingScrollRatio.current = null;
    });
    return () => cancelAnimationFrame(raf);
  }, [pageWidth]);

  // Drag-to-pan handlers
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const container = containerRef.current;
    if (!container) return;
    dragRef.current = {
      isDragging: true,
      startX: e.clientX,
      startY: e.clientY,
      scrollLeft: container.scrollLeft,
      scrollTop: container.scrollTop,
    };
    container.setPointerCapture(e.pointerId);
    container.style.cursor = "grabbing";
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current.isDragging) return;
    const container = containerRef.current;
    if (!container) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    container.scrollLeft = dragRef.current.scrollLeft - dx;
    container.scrollTop = dragRef.current.scrollTop - dy;
  }, []);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    dragRef.current.isDragging = false;
    const container = containerRef.current;
    if (container) {
      container.releasePointerCapture(e.pointerId);
      container.style.cursor = "grab";
    }
  }, []);

  const loading = (
    <div className="flex h-full items-center justify-center">
      <Loader size="md" />
    </div>
  );

  return (
    <div className="relative flex h-full w-full flex-col">
      {/* Zoom controls */}
      {pageWidth && (
        <div className="absolute right-4 top-2 z-10 flex items-center gap-1 rounded bg-white/90 px-1 py-0.5 shadow">
          <ActionIcon
            variant="subtle"
            size="sm"
            onClick={() => setZoom(Math.max(zoom / 1.25, 0.25))}
            aria-label="Zoom out"
          >
            <IconZoomOut size={16} />
          </ActionIcon>
          <button
            className="min-w-[3ch] text-center text-xs text-gray-600 hover:text-gray-900"
            onClick={() => setZoom(1)}
            title="Reset zoom"
          >
            {Math.round(zoom * 100)}%
          </button>
          <ActionIcon
            variant="subtle"
            size="sm"
            onClick={() => setZoom(Math.min(zoom * 1.25, 5))}
            aria-label="Zoom in"
          >
            <IconZoomIn size={16} />
          </ActionIcon>
        </div>
      )}

      {/* Warning for quotes that couldn't be located in the PDF */}
      {unresolvedQuotes.length > 0 && (
        <Alert
          icon={<IconAlertTriangle size={16} />}
          color="yellow"
          variant="light"
          className="rounded-none"
        >
          {unresolvedQuotes.map((quote, i) => (
            <div key={i}>
              Could not locate quote in PDF: &ldquo;{quote}&rdquo;
            </div>
          ))}
        </Alert>
      )}

      {/* Scrollable PDF area */}
      <div
        ref={containerRef}
        className="min-h-0 flex-1 overflow-auto"
        style={{ cursor: "grab" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {!reactPdf || !containerSize ? (
          loading
        ) : (
          <reactPdf.Document
            file={pdfUrl}
            onLoadSuccess={({ numPages: n }) => setNumPages(n)}
            loading={loading}
            options={documentOptions}
          >
            {numPages &&
              Array.from({ length: numPages }, (_, i) => {
                const pageNum = i + 1;
                const bboxes = highlightsByPage.get(pageNum);
                return (
                  <div
                    key={pageNum}
                    ref={pageNum === targetPage ? targetPageRef : undefined}
                    className="flex justify-center"
                  >
                    <reactPdf.Page
                      pageNumber={pageNum}
                      width={pageWidth}
                      renderTextLayer={false}
                      renderAnnotationLayer={false}
                      onLoadSuccess={handleFirstPageLoad}
                      onRenderSuccess={() => handlePageRenderSuccess(pageNum)}
                    >
                      {bboxes && <HighlightOverlay bboxes={bboxes} />}
                    </reactPdf.Page>
                  </div>
                );
              })}
          </reactPdf.Document>
        )}
      </div>
    </div>
  );
};
