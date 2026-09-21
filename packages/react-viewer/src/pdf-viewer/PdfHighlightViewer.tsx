import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActionIcon,
  Alert,
  Button,
  Loader,
  Progress,
  Text,
  TextInput,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconChevronDown,
  IconChevronUp,
  IconReload,
  IconRotate,
  IconSearch,
  IconX,
  IconZoomIn,
  IconZoomOut,
} from "@tabler/icons-react";
import type { HighlightBbox, PdfHighlight } from "./types";
import { rotateBbox, turn, SCALE, type Rotation } from "./geometry";
import {
  buildDocumentIndex,
  searchIndex,
  type PageTextIndex,
  type PdfDocumentLike,
  type SearchHit,
} from "./text-search";

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
  /**
   * Controlled rotation, a quarter turn applied on top of each page's own.
   * When provided, overrides internal state. The pane resets its own
   * rotation when another document opens; a controlled consumer does the
   * same, as the shell does when the paper changes.
   */
  rotation?: Rotation;
  /** Called when the user turns the document via the built-in controls. */
  onRotationChange?: (rotation: Rotation) => void;
  /** URL of pdf.js worker (`pdf.worker.min.mjs`), served by the consumer. */
  workerSrc: string;
  /** URL prefix for pdf.js cmaps (e.g. `/pdfjs/cmaps/`), served by the consumer. */
  cMapUrl: string;
  /**
   * Called when a document fails to load, with pdf.js's error and a
   * classification of it. Retry re-uses the same `pdfUrl`, so a consumer
   * that hands out short-lived URLs can mint a new one here when `info`
   * says the server answered with 403; a changed `pdfUrl` starts a fresh
   * load, and a fresh load that fails calls this again, so the consumer
   * bounds its own retries.
   */
  onLoadError?: (error: Error, info: LoadErrorInfo) => void;
  /**
   * Open the find bar on Ctrl+F / Cmd+F while the pane is shown. The
   * shortcut is taken when focus is in the pane, or on nothing in
   * particular after the pane was the last thing pointed at or focused, so
   * the rest of the page keeps the browser's own find. Defaults to true.
   */
  captureFindShortcut?: boolean;
}

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
    // A failed import (a chunk that did not download, typically) is not
    // cached: the next mount or an explicit retry imports again.
    promise.catch(() => {
      if (cached?.promise === promise) cached = null;
    });
    cached = { promise, workerSrc };
  }
  return cached.promise;
}

interface ReactPdfLoad {
  mod: ReactPdfModule | null;
  error: Error | null;
  retry(): void;
}

function useReactPdf(workerSrc: string): ReactPdfLoad {
  const [mod, setMod] = useState<ReactPdfModule | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    // A module configured for another worker is not this one's.
    setMod(null);
    setError(null);
    loadReactPdf(workerSrc).then(
      (m) => {
        if (!cancelled) setMod(m);
      },
      (e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [workerSrc, attempt]);
  const retry = useCallback(() => {
    setError(null);
    setAttempt((n) => n + 1);
  }, []);
  return { mod, error, retry };
}

function formatBytes(n: number): string {
  const kb = Math.round(n / 1024);
  if (kb >= 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (kb >= 1) return `${kb} KB`;
  return `${Math.round(n)} B`;
}

interface LoadProgress {
  loaded: number;
  /** Null when the server did not report a content length. */
  total: number | null;
}

/** How long without a progress report before the loading state offers a way out. */
const STALL_MS = 15_000;

/**
 * Loading placeholder. With progress it names the bytes received and, when
 * the total is known, the total and a bar, so a slow download of a large
 * document is distinguishable from a stalled one.
 */
function LoadingState({
  progress,
  onRetry,
}: {
  progress: LoadProgress | null;
  /** Offered once the download has gone quiet for a while. */
  onRetry?: () => void;
}) {
  const total = progress?.total ?? null;
  // In range mode pdf.js counts whole chunks, so `loaded` can pass `total`.
  const loaded =
    progress && total !== null
      ? Math.min(progress.loaded, total)
      : progress?.loaded;
  const percent =
    loaded !== undefined && total !== null
      ? Math.min(100, Math.round((loaded / total) * 100))
      : null;
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-2"
      data-testid="pdf-loading"
    >
      <Loader size="md" />
      {loaded !== undefined && (
        <Text size="xs" c="dimmed">
          {total !== null
            ? `${formatBytes(loaded)} of ${formatBytes(total)} (${percent}%)`
            : `${formatBytes(loaded)} received`}
        </Text>
      )}
      {percent !== null && (
        <Progress
          value={percent}
          size="xs"
          className="w-48"
          aria-label="Download progress"
        />
      )}
      {onRetry && (
        <>
          <Text size="xs" c="dimmed">
            Still waiting for the server.
          </Text>
          <Button
            size="xs"
            variant="light"
            leftSection={<IconReload size={14} />}
            onClick={onRetry}
          >
            Retry
          </Button>
        </>
      )}
    </div>
  );
}

export type LoadErrorKind =
  | "not-found"
  | "http"
  | "invalid"
  | "password"
  | "aborted"
  | "network"
  | "unknown";

/** What went wrong with a load, for a consumer deciding how to react. */
export interface LoadErrorInfo {
  kind: LoadErrorKind;
  /** The HTTP status, for `kind: "http"`. */
  status?: number;
}

/** Sort a pdf.js load error by its exception name and properties. */
export function classifyLoadError(error: Error): LoadErrorInfo {
  const status = (error as { status?: unknown }).status;
  const details = String((error as { details?: unknown }).details ?? "");
  switch (error.name) {
    case "MissingPDFException":
      return { kind: "not-found" };
    case "UnexpectedResponseException":
      return typeof status === "number"
        ? { kind: "http", status }
        : { kind: "http" };
    case "InvalidPDFException":
      return { kind: "invalid" };
    case "PasswordException":
      return { kind: "password" };
    case "AbortException":
      return { kind: "aborted" };
    case "UnknownErrorException":
      // A fetch that never got a response (offline, or CORS refused it)
      // comes back wrapped, with the browser's own wording inside. A parser
      // crash arrives the same way, so only the browsers' fetch phrasings
      // count, never a bare TypeError.
      return /Failed to fetch|NetworkError when attempting to fetch|Load failed/.test(
        `${error.message} ${details}`,
      )
        ? { kind: "network" }
        : { kind: "unknown" };
    default:
      return { kind: "unknown" };
  }
}

/**
 * A short line for the alert. pdf.js's own messages embed the full URL of
 * the document, which for a presigned link runs to several hundred
 * characters and buries the cause; the raw message stays available as the
 * line's tooltip.
 */
export function describeLoadError(error: Error): string {
  const info = classifyLoadError(error);
  switch (info.kind) {
    case "not-found":
      return "The file was not found on the server.";
    case "http":
      return info.status !== undefined
        ? `The server answered with status ${info.status}.`
        : "The server answered unexpectedly.";
    case "invalid":
      return "The file is not a valid PDF.";
    case "password":
      return "The PDF is password protected.";
    case "aborted":
      return "The download was interrupted.";
    case "network":
      return "The download failed: a network or CORS error.";
    case "unknown":
      return error.message || "Unknown error";
  }
}

function LoadFailure({
  title,
  error,
  onRetry,
}: {
  title: string;
  error: Error;
  onRetry(): void;
}) {
  return (
    <div className="flex h-full items-center justify-center p-4">
      <Alert
        icon={<IconAlertTriangle size={16} />}
        color="red"
        variant="light"
        title={title}
        className="max-w-md"
        data-testid="pdf-load-error"
      >
        <div title={error.message}>{describeLoadError(error)}</div>
        <Button
          size="xs"
          variant="light"
          color="red"
          mt="xs"
          leftSection={<IconReload size={14} />}
          onClick={onRetry}
        >
          Retry
        </Button>
      </Alert>
    </div>
  );
}

type DocumentProps = ComponentProps<ReactPdfModule["Document"]>;

/** Numbers PdfDocument mounts, so one load can be told from another of the same URL. */
let nextLoadId = 1;

interface PdfDocumentProps {
  reactPdf: ReactPdfModule;
  pdfUrl: string;
  /**
   * Read once, at first render: react-pdf restarts the load inside the same
   * instance when this object changes identity, and the superseded task
   * then still reports into this instance's state.
   */
  options: DocumentProps["options"];
  onLoadSuccess: (
    doc: Parameters<NonNullable<DocumentProps["onLoadSuccess"]>>[0],
    loadId: number,
  ) => void;
  onLoadError?: (error: Error, info: LoadErrorInfo) => void;
  /** Rendered inside the document, with the id of this load. */
  children: (loadId: number) => ReactNode;
}

/**
 * One document's load. Owns the progress and error state so that they die
 * with the instance: the parent keys this on the URL, and react-pdf keeps a
 * superseded download running until it settles, still reporting progress
 * to the callbacks it was given. Held here, those reports land on an
 * unmounted component and go nowhere instead of into the next document's
 * state. A source that cannot be read at all never reaches react-pdf's
 * error slot, so the failure state is decided here rather than left to it.
 */
function PdfDocument({
  reactPdf,
  pdfUrl,
  options,
  onLoadSuccess,
  onLoadError,
  children,
}: PdfDocumentProps) {
  // One id per mount: state a page reports under it can be told from the
  // same URL's previous load.
  const [loadId] = useState(() => nextLoadId++);
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [stalled, setStalled] = useState(false);
  // Held at first render so react-pdf never reloads inside this instance.
  const optionsRef = useRef(options);
  // pdf.js keeps fetching the rest of a document after it has resolved;
  // those reports are of no use once pages are showing.
  const loadedRef = useRef(false);
  // While the failure shows, the Document is unmounted; clearing the error
  // mounts a fresh one, which starts the download over.
  const retry = useCallback(() => {
    loadedRef.current = false;
    setError(null);
    setProgress(null);
    setStalled(false);
  }, []);
  const fail = useCallback(
    (e: Error) => {
      setError(e);
      onLoadError?.(e, classifyLoadError(e));
    },
    [onLoadError],
  );
  // A request that connects but never sends bytes raises no error, so after
  // a while without a report the loading state offers Retry itself.
  useEffect(() => {
    if (error) return;
    setStalled(false);
    const timer = setTimeout(() => setStalled(true), STALL_MS);
    return () => clearTimeout(timer);
  }, [progress, error]);

  if (error) {
    return (
      <LoadFailure
        title="Could not load this PDF"
        error={error}
        onRetry={retry}
      />
    );
  }
  const loading = (
    <LoadingState progress={progress} onRetry={stalled ? retry : undefined} />
  );
  return (
    <reactPdf.Document
      file={pdfUrl}
      onLoadSuccess={(doc) => {
        loadedRef.current = true;
        onLoadSuccess(doc, loadId);
      }}
      onLoadProgress={({ loaded, total }) => {
        if (loadedRef.current) return;
        setProgress({
          loaded,
          total: Number.isFinite(total) && total > 0 ? total : null,
        });
      }}
      onLoadError={fail}
      onSourceError={fail}
      // An encrypted file would otherwise loop through react-pdf's
      // window.prompt; rejecting makes pdf.js report the PasswordException.
      onPassword={(callback) =>
        (callback as unknown as (value: Error) => void)(
          new Error("password required"),
        )
      }
      loading={loading}
      // react-pdf paints its own error slot for a frame before onLoadError
      // fires; keep the loading state there so no foreign text shows.
      error={loading}
      options={optionsRef.current}
    >
      {children(loadId)}
    </reactPdf.Document>
  );
}

const QUOTE_COLOR = "rgb(255, 210, 90)";
const MATCH_COLOR = "rgb(180, 210, 255)";
const CURRENT_MATCH_COLOR = "rgb(255, 165, 80)";

interface OverlayLayer {
  bboxes: HighlightBbox[];
  color: string;
}

/**
 * Render bbox highlights for a page as a single overlay (non-multiplicative
 * within a layer; layers are drawn in order, so a later one wins where two
 * cover the same text).
 */
/** A 0–SCALE coordinate as a CSS percentage, rounded so styles carry no floating-point noise. */
function pct(value: number): string {
  return `${Math.round((value / SCALE) * 100000) / 1000}%`;
}

function HighlightOverlay({ layers }: { layers: OverlayLayer[] }) {
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
      {layers.flatMap((layer, i) =>
        layer.bboxes.map((bbox, j) => (
          <div
            key={`${i}-${j}`}
            style={{
              position: "absolute",
              left: pct(bbox.left),
              top: pct(bbox.top),
              width: pct(bbox.right - bbox.left),
              height: pct(bbox.bottom - bbox.top),
              backgroundColor: layer.color,
            }}
          />
        )),
      )}
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
  rotation: externalRotation,
  onRotationChange,
  workerSrc,
  cMapUrl,
  onLoadError,
  captureFindShortcut = true,
}: PdfHighlightViewerProps) => {
  const {
    mod: reactPdf,
    error: moduleError,
    retry: retryModule,
  } = useReactPdf(workerSrc);

  // Per-load state is tagged with the load it came from and read only while
  // that load is the current one, rather than reset in an effect: the new
  // document's own callbacks can run in the same commit as the URL change,
  // and an effect that ran after them would wipe what they set. The URL
  // guards against the previous document's values, the load id against a
  // previous load of the same URL.
  const [loadedDoc, setLoadedDoc] = useState<{
    loadId: number;
    url: string;
    numPages: number;
    doc: PdfDocumentLike;
  } | null>(null);
  const currentLoad = loadedDoc?.url === pdfUrl ? loadedDoc : null;
  const numPages = currentLoad?.numPages ?? null;
  const currentLoadId = currentLoad?.loadId ?? null;
  const pdfDoc = currentLoad?.doc ?? null;
  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef(new Map<number, HTMLDivElement>());
  // The load whose target highlight has been scrolled to once.
  const scrolledLoadRef = useRef<number | null>(null);

  // Find in document. The index belongs to one loaded document and is
  // tagged with its proxy; the query outlives the document so the same
  // term can be looked for in the next one.
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  // Once the bar has been opened for a document its index is wanted, even
  // if the bar closes again before the build finishes.
  const [indexWantedFor, setIndexWantedFor] = useState<PdfDocumentLike | null>(
    null,
  );
  const [index, setIndex] = useState<{
    doc: PdfDocumentLike;
    /** Null when the build itself failed, as opposed to single pages. */
    pages: PageTextIndex[] | null;
  } | null>(null);
  const textIndex = index?.doc === pdfDoc ? index.pages : null;
  const indexFailed = index?.doc === pdfDoc && index.pages === null;
  // The selection is tagged with the hits it was made in, so a new set of
  // hits starts at the first match with no effect and no stale index.
  const [selection, setSelection] = useState<{
    hits: SearchHit[];
    index: number;
  } | null>(null);
  // Every user action that should move the view to the current match bumps
  // this; the scroll effect keys on it and records what it handled, so a
  // request is acted on or superseded and never left standing for hits
  // that arrive for another reason, such as the next document's index.
  const [scrollRequest, setScrollRequest] = useState(0);
  const handledScrollRequest = useRef(0);
  const findInputRef = useRef<HTMLInputElement>(null);
  const findBarId = useId();
  // Whether the pane was the last thing pointed at or focused, so Ctrl+F
  // with focus on nothing in particular can be attributed to it.
  const paneActiveRef = useRef(false);
  // For callbacks that must not re-subscribe when the bar opens or closes.
  const findOpenRef = useRef(findOpen);
  findOpenRef.current = findOpen;
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

  // The first page's unrotated aspect ratio (width / height in PDF points)
  // and its own /Rotate entry. The ratio the document displays at follows
  // from both together with the user's turn.
  const [firstPageState, setFirstPageState] = useState<{
    loadId: number;
    ratio: number;
    rotate: number;
  } | null>(null);
  const firstPage =
    firstPageState !== null && firstPageState.loadId === currentLoadId
      ? firstPageState
      : null;
  // Each page's own /Rotate entry, recorded as it loads and tagged with the
  // load it belongs to. react-pdf's `rotate` prop is absolute, so a page is
  // handed its own rotation plus the user's turn, never another page's.
  const [pageRotations, setPageRotations] = useState<{
    loadId: number;
    byPage: Record<number, number>;
  }>({ loadId: 0, byPage: {} });
  const [ownRotation, setOwnRotation] = useState<Rotation>(0);
  const rotation = externalRotation ?? ownRotation;
  // For callbacks that must not re-subscribe on every turn.
  const rotationRef = useRef(rotation);
  rotationRef.current = rotation;
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
  // One counter-clockwise quarter turn; four bring the page back. A turn
  // re-lays the pages out like a zoom does, so the same scroll ratio is
  // captured and restored around it.
  const rotate = useCallback(() => {
    const container = containerRef.current;
    if (container && container.scrollHeight > 0) {
      pendingScrollRatio.current = container.scrollTop / container.scrollHeight;
    }
    const next = turn(rotationRef.current, -1);
    setOwnRotation(next);
    onRotationChange?.(next);
  }, [onRotationChange]);

  // Highlights with no bboxes split two ways: still resolving (pending) vs
  // searched-and-not-found. The viewer surfaces them differently so an
  // in-flight resolve doesn't read as a failure.
  const pendingQuotes = useMemo(
    () =>
      (highlights ?? [])
        .filter((h) => h.bboxes.length === 0 && h.pending && h.label)
        .map((h) => h.label!),
    [highlights],
  );
  const unresolvedQuotes = useMemo(
    () =>
      (highlights ?? [])
        .filter((h) => h.bboxes.length === 0 && !h.pending && h.label)
        .map((h) => h.label!),
    [highlights],
  );

  // Group highlights by page number (1-indexed, matching PDF conventions),
  // in the frame of the page as currently turned.
  const highlightsByPage = useMemo(() => {
    const map = new Map<number, HighlightBbox[]>();
    for (const h of highlights ?? []) {
      for (const bbox of h.bboxes) {
        const pageNum = bbox.page;
        const list = map.get(pageNum) ?? [];
        list.push(rotateBbox(bbox, rotation));
        map.set(pageNum, list);
      }
    }
    return map;
  }, [highlights, rotation]);

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

  // Record each page's own rotation as it loads, and page 1's view box for
  // the fit. ``view`` is [x0, y0, x1, y1] in PDF points before rotation, so
  // the extents are differences, not the far corner; ``rotate`` is the page's
  // own /Rotate entry, which react-pdf applies unless told otherwise.
  // react-pdf fires this again on every re-render of the page, so both
  // updates keep the previous state when nothing changed.
  const handlePageLoad = useCallback(
    (
      loadId: number,
      pageNum: number,
      page: { view: number[]; rotate: number },
    ) => {
      setPageRotations((prev) =>
        prev.loadId === loadId && prev.byPage[pageNum] === page.rotate
          ? prev
          : {
              loadId,
              byPage: {
                ...(prev.loadId === loadId ? prev.byPage : {}),
                [pageNum]: page.rotate,
              },
            },
      );
      if (pageNum === 1) {
        const width = (page.view[2] ?? 0) - (page.view[0] ?? 0);
        const height = (page.view[3] ?? 0) - (page.view[1] ?? 0);
        setFirstPageState((prev) =>
          prev?.loadId === loadId
            ? prev
            : {
                loadId,
                ratio: height > 0 ? width / height : 1,
                rotate: page.rotate,
              },
        );
      }
    },
    [],
  );

  // Rotation a page renders at: its own plus the user's turn. Undefined
  // until that page has loaded, so react-pdf keeps applying the page's own
  // rotation meanwhile; a page loading under a non-zero turn therefore
  // renders once at its own rotation and once more turned, and its overlay
  // is withheld until the frame is known.
  const rotateFor = (loadId: number, pageNum: number): number | undefined => {
    const own =
      pageRotations.loadId === loadId
        ? pageRotations.byPage[pageNum]
        : undefined;
    return own === undefined ? undefined : (own + rotation) % 360;
  };

  // Aspect ratio of the page as displayed. A quarter turn from either
  // source swaps the sides; a /Rotate=90 page turned once more is upright
  // again.
  const pageAspectRatio = useMemo(() => {
    if (!firstPage) return null;
    const quarterTurned = (firstPage.rotate + rotation) % 180 === 90;
    return quarterTurned ? 1 / firstPage.ratio : firstPage.ratio;
  }, [firstPage, rotation]);

  // Compute page render width: fit one full page in the viewport, then apply zoom
  const pageWidth = useMemo(() => {
    if (!containerSize || !pageAspectRatio) return undefined;
    const fitHeightWidth = containerSize.height * pageAspectRatio;
    const baseWidth = Math.min(fitHeightWidth, containerSize.width);
    return baseWidth * zoom;
  }, [containerSize, pageAspectRatio, zoom]);

  // First bbox on the target page (for sub-page scroll positioning), in the
  // page's own frame. The turn is applied when scrolling, from the ref, so
  // that turning the document does not count as the highlight changing.
  const firstBbox = useMemo(() => {
    for (const h of highlights ?? []) {
      if (h.bboxes.length > 0) return h.bboxes[0]!;
    }
    return undefined;
  }, [highlights]);

  // Scroll the container so a bbox on a page (or, without one, the page
  // itself) is visible.
  const scrollToBbox = useCallback(
    (pageNum: number, bbox: HighlightBbox | undefined) => {
      const pageDiv = pageRefs.current.get(pageNum);
      const container = containerRef.current;
      if (!pageDiv || !container) return;

      if (bbox) {
        const pageHeight = pageDiv.offsetHeight;
        const bboxTop = (bbox.top / SCALE) * pageHeight;
        const bboxBottom = (bbox.bottom / SCALE) * pageHeight;
        const bboxCenter = pageDiv.offsetTop + (bboxTop + bboxBottom) / 2;
        const scrollTarget = bboxCenter - container.clientHeight / 3;
        container.scrollTo({ top: Math.max(0, scrollTarget) });
      } else {
        pageDiv.scrollIntoView({ block: "start" });
      }
    },
    [],
  );

  // Scroll the container so the target highlight is visible
  const scrollToHighlight = useCallback(
    () =>
      scrollToBbox(
        targetPage,
        firstBbox && rotateBbox(firstBbox, rotationRef.current),
      ),
    [scrollToBbox, targetPage, firstBbox],
  );

  // Scroll to the bbox location after the target page's canvas has rendered
  const handlePageRenderSuccess = useCallback(
    (loadId: number, pageNum: number) => {
      if (pageNum !== targetPage || scrolledLoadRef.current === loadId) return;
      scrolledLoadRef.current = loadId;
      scrollToHighlight();
    },
    [targetPage, scrollToHighlight],
  );

  // The turn was chosen for the previous document; zoom is kept on purpose.
  useEffect(() => {
    setOwnRotation(0);
  }, [pdfUrl]);

  // The index is wanted once the bar has been opened with a document loaded.
  useEffect(() => {
    if (findOpen && pdfDoc) setIndexWantedFor(pdfDoc);
  }, [findOpen, pdfDoc]);

  // Build the index once per document, and keep building if the bar closes
  // meanwhile. A page whose text cannot be read is indexed as empty, so one
  // corrupt font does not switch find off for the paper.
  useEffect(() => {
    const doc = indexWantedFor;
    if (!doc || doc !== pdfDoc || index?.doc === doc) return;
    let cancelled = false;
    buildDocumentIndex(doc, () => cancelled).then(
      (pages) => {
        if (!cancelled && pages) setIndex({ doc, pages });
      },
      () => {
        if (!cancelled) setIndex({ doc, pages: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [indexWantedFor, pdfDoc, index]);

  // Search a beat after the last keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 120);
    return () => clearTimeout(timer);
  }, [query]);

  const search = useMemo(
    () =>
      textIndex
        ? searchIndex(textIndex, debouncedQuery)
        : { hits: [], capped: false },
    [textIndex, debouncedQuery],
  );
  const hits = search.hits;
  // A document without a text layer indexes to pages without a single run.
  const hasText = textIndex?.some((p) => p.runs.length > 0) ?? true;
  // Counts from the render the document lands in, before the effect that
  // records the want has run, so a persisted query does not read as "No
  // matches" for a document that has not been searched.
  const indexing =
    pdfDoc !== null &&
    (findOpen || indexWantedFor === pdfDoc) &&
    index?.doc !== pdfDoc;
  const safeHitIndex =
    selection?.hits === hits && hits.length
      ? Math.min(selection.index, hits.length - 1)
      : 0;
  const currentHit = hits[safeHitIndex];

  // Bring the current match into view for a request the user made. The
  // request waits while there is no document yet, while the index builds
  // and while the search catches up with what was typed; it is dropped
  // once the bar is closed or the index has failed.
  useEffect(() => {
    if (handledScrollRequest.current === scrollRequest) return;
    if (!findOpen || indexFailed) {
      handledScrollRequest.current = scrollRequest;
      return;
    }
    if (!pdfDoc || textIndex === null || debouncedQuery !== query) return;
    handledScrollRequest.current = scrollRequest;
    if (!currentHit) return;
    const first = currentHit.bboxes[0];
    scrollToBbox(
      currentHit.page,
      first ? rotateBbox(first, rotationRef.current) : undefined,
    );
  }, [
    scrollRequest,
    findOpen,
    pdfDoc,
    indexFailed,
    query,
    debouncedQuery,
    textIndex,
    currentHit,
    scrollToBbox,
  ]);

  // Matches per page, the current one apart, in the frame of the page as
  // turned. Empty while the find bar is closed so nothing is drawn.
  const matchesByPage = useMemo(() => {
    const map = new Map<
      number,
      { others: HighlightBbox[]; current: HighlightBbox[] }
    >();
    if (!findOpen) return map;
    hits.forEach((hit, i) => {
      const entry = map.get(hit.page) ?? { others: [], current: [] };
      const target = i === safeHitIndex ? entry.current : entry.others;
      for (const bbox of hit.bboxes) target.push(rotateBbox(bbox, rotation));
      map.set(hit.page, entry);
    });
    return map;
  }, [findOpen, hits, safeHitIndex, rotation]);

  const requestScroll = useCallback(() => setScrollRequest((n) => n + 1), []);
  const openFind = useCallback(() => {
    // Opening moves to the current match; refocusing an open bar does not
    // pull a reader back from where they scrolled.
    if (!findOpenRef.current) requestScroll();
    setFindOpen(true);
    // The input mounts on the next render; focus it once it exists.
    requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  }, [requestScroll]);
  const closeFind = useCallback(() => {
    setFindOpen(false);
    // Hand focus back to the pane rather than letting it fall to the body.
    rootRef.current?.focus();
  }, []);
  const stepHit = useCallback(
    (delta: 1 | -1) => {
      if (hits.length === 0) return;
      setSelection({
        hits,
        index: (safeHitIndex + delta + hits.length) % hits.length,
      });
      requestScroll();
    },
    [hits, safeHitIndex, requestScroll],
  );

  // Ctrl+F / Cmd+F opens the find bar when focus is in the pane, or on
  // nothing in particular after the pane was the last thing pointed at or
  // focused. Anything else keeps the browser's own find, which can still
  // search the rest of the page; inside the pane there is nothing else for
  // it to search.
  useEffect(() => {
    if (!captureFindShortcut) return;
    const inPane = (target: EventTarget | null) =>
      target instanceof Node && !!rootRef.current?.contains(target);
    const track = (e: Event) => {
      paneActiveRef.current = inPane(e.target);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      // The letter decides on Latin layouts; the physical key only where
      // the layout produces no Latin letter, so Ctrl+P on Colemak stays
      // print rather than find.
      const isF =
        e.key.toLowerCase() === "f" ||
        (!/^[a-z]$/i.test(e.key) && e.code === "KeyF");
      if (
        !isF ||
        !(e.ctrlKey || e.metaKey) ||
        e.altKey ||
        e.shiftKey ||
        e.isComposing ||
        e.defaultPrevented
      )
        return;
      const target = e.target;
      const nothingFocused =
        target === null ||
        target === window ||
        target === document.body ||
        target === document.documentElement;
      if (!inPane(target) && !(nothingFocused && paneActiveRef.current)) return;
      // A held key must not fall through to the browser's own find either.
      e.preventDefault();
      if (e.repeat) return;
      openFind();
    };
    window.addEventListener("pointerdown", track, true);
    window.addEventListener("focusin", track, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", track, true);
      window.removeEventListener("focusin", track, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [captureFindShortcut, openFind]);

  const findStatus = !pdfDoc
    ? ""
    : indexing
      ? "Indexing…"
      : indexFailed || !hasText
        ? "Text unavailable"
        : debouncedQuery.trim() === ""
          ? ""
          : hits.length === 0
            ? "No matches"
            : `${safeHitIndex + 1} of ${hits.length}${search.capped ? "+" : ""}`;

  // Re-scroll when highlights change (claim navigation within the same PDF).
  // Skips a load whose target page has not rendered yet, which
  // handlePageRenderSuccess handles when it does. The current load is read
  // through a ref so that a load completing does not itself run this: the
  // pages mount in that same commit and scroll on their own render.
  const currentLoadIdRef = useRef(currentLoadId);
  currentLoadIdRef.current = currentLoadId;
  useEffect(() => {
    const loadId = currentLoadIdRef.current;
    if (loadId === null || scrolledLoadRef.current !== loadId) return;
    scrollToHighlight();
  }, [targetPage, firstBbox, scrollToHighlight]);

  // Restore scroll position proportionally after a zoom- or rotation-driven
  // re-layout. Runs on every pageWidth or rotation change; the guard on
  // pendingScrollRatio.current ensures it only fires when a zoom or a turn
  // actually triggered it (not on initial load or container resize). Uses
  // useLayoutEffect so the scroll jump is applied before the browser paints
  // — users don't see the flash to top. A rAF-delayed second application
  // catches the case where react-pdf's canvases are still resizing when the
  // first attempt ran; by the next frame, scrollHeight reflects the final
  // layout.
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
  }, [pageWidth, rotation]);

  // Drag-to-pan handlers
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const container = containerRef.current;
    if (!container) return;
    // Capturing the pointer would retarget the click away from a control
    // inside the container, such as the Retry button.
    const target = e.target as Element | null;
    if (
      typeof target?.closest === "function" &&
      target.closest("button, a, input, select, textarea, [role='button']")
    )
      return;
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

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="relative flex h-full w-full flex-col outline-hidden"
      onKeyDown={(e) => {
        if (e.key === "Escape" && findOpen && !e.nativeEvent.isComposing) {
          // Ours to close; a dialog around the pane should not close too.
          e.preventDefault();
          e.stopPropagation();
          closeFind();
        }
      }}
    >
      {/* Find bar */}
      {findOpen && (
        <div
          id={findBarId}
          role="search"
          className="absolute left-4 top-2 z-10 flex items-center gap-1 rounded bg-white/95 px-2 py-1 shadow"
          data-testid="pdf-find-bar"
        >
          <TextInput
            ref={findInputRef}
            size="xs"
            placeholder="Find in document"
            aria-label="Search text"
            value={query}
            onChange={(e) => {
              setQuery(e.currentTarget.value);
              requestScroll();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                stepHit(e.shiftKey ? -1 : 1);
              }
            }}
            autoFocus
            className="w-56"
          />
          <Text
            size="xs"
            c="dimmed"
            className="min-w-[9ch] text-center"
            role="status"
            aria-live="polite"
            data-testid="pdf-find-status"
          >
            {findStatus}
          </Text>
          <ActionIcon
            variant="subtle"
            size="sm"
            onClick={() => stepHit(-1)}
            disabled={hits.length === 0}
            aria-label="Previous match"
          >
            <IconChevronUp size={16} />
          </ActionIcon>
          <ActionIcon
            variant="subtle"
            size="sm"
            onClick={() => stepHit(1)}
            disabled={hits.length === 0}
            aria-label="Next match"
          >
            <IconChevronDown size={16} />
          </ActionIcon>
          <ActionIcon
            variant="subtle"
            size="sm"
            onClick={closeFind}
            aria-label="Close find"
          >
            <IconX size={16} />
          </ActionIcon>
        </div>
      )}

      {/* Find, rotation and zoom controls */}
      {pageWidth && (
        <div className="absolute right-4 top-2 z-10 flex items-center gap-1 rounded bg-white/90 px-1 py-0.5 shadow">
          <ActionIcon
            variant="subtle"
            size="sm"
            onClick={openFind}
            aria-label="Find in document"
            title="Find in document"
            aria-expanded={findOpen}
            aria-controls={findBarId}
            aria-keyshortcuts="Control+F Meta+F"
          >
            <IconSearch size={16} />
          </ActionIcon>
          <span className="mx-1 h-4 w-px bg-gray-300" aria-hidden="true" />
          <ActionIcon
            variant="subtle"
            size="sm"
            onClick={rotate}
            aria-label="Rotate left"
            title="Rotate left"
          >
            <IconRotate size={16} />
          </ActionIcon>
          <span className="mx-1 h-4 w-px bg-gray-300" aria-hidden="true" />
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

      {/* In-flight: quote bboxes are still being resolved */}
      {pendingQuotes.length > 0 && (
        <Alert
          icon={<Loader size={16} />}
          color="blue"
          variant="light"
          className="rounded-none"
        >
          {pendingQuotes.map((quote, i) => (
            <div key={i}>Locating quote in PDF: &ldquo;{quote}&rdquo;</div>
          ))}
        </Alert>
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
        {moduleError && !reactPdf ? (
          <LoadFailure
            title="Could not load the PDF viewer"
            error={moduleError}
            onRetry={retryModule}
          />
        ) : !reactPdf || !containerSize ? (
          <LoadingState progress={null} />
        ) : (
          <PdfDocument
            key={pdfUrl}
            reactPdf={reactPdf}
            pdfUrl={pdfUrl}
            options={documentOptions}
            onLoadSuccess={(doc, loadId) =>
              setLoadedDoc({
                loadId,
                url: pdfUrl,
                numPages: doc.numPages,
                doc,
              })
            }
            onLoadError={onLoadError}
          >
            {(loadId) =>
              numPages &&
              Array.from({ length: numPages }, (_, i) => {
                const pageNum = i + 1;
                const quoteBboxes = highlightsByPage.get(pageNum);
                const matches = matchesByPage.get(pageNum);
                const layers: OverlayLayer[] = [];
                if (quoteBboxes)
                  layers.push({ bboxes: quoteBboxes, color: QUOTE_COLOR });
                if (matches?.others.length)
                  layers.push({ bboxes: matches.others, color: MATCH_COLOR });
                if (matches?.current.length)
                  layers.push({
                    bboxes: matches.current,
                    color: CURRENT_MATCH_COLOR,
                  });
                const pageRotate = rotateFor(loadId, pageNum);
                return (
                  // `safe center` keeps the page reachable when zoomed wider than the
                  // viewport; plain `justify-content: center` puts the page at a negative
                  // x offset and the browser's scroll only exposes positive-x overflow,
                  // so the left edge becomes unreachable by scrollbar or drag-to-pan.
                  <div
                    key={pageNum}
                    ref={(el) => {
                      if (el) pageRefs.current.set(pageNum, el);
                      else pageRefs.current.delete(pageNum);
                    }}
                    className="flex"
                    style={{ justifyContent: "safe center" }}
                  >
                    <reactPdf.Page
                      pageNumber={pageNum}
                      width={pageWidth}
                      rotate={pageRotate}
                      renderTextLayer={false}
                      renderAnnotationLayer={false}
                      onLoadSuccess={(page) =>
                        handlePageLoad(loadId, pageNum, page)
                      }
                      onRenderSuccess={() =>
                        handlePageRenderSuccess(loadId, pageNum)
                      }
                    >
                      {layers.length > 0 && pageRotate !== undefined && (
                        <HighlightOverlay layers={layers} />
                      )}
                    </reactPdf.Page>
                  </div>
                );
              })
            }
          </PdfDocument>
        )}
      </div>
    </div>
  );
};
