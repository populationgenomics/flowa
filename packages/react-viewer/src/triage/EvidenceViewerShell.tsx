import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Alert,
  Button,
  Loader,
  SegmentedControl,
  Select,
  Stack,
  Text,
} from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";
import type { PaperIdMapping } from "../citations/types";
import { PdfHighlightViewer } from "../pdf-viewer/PdfHighlightViewer";
import type { PdfHighlight } from "../pdf-viewer/types";
import { MarkdownHighlightViewer } from "../markdown-viewer/MarkdownHighlightViewer";
import { groupClaimsByPaper, resolveClaimForCitation } from "./claim-refs";
import { flattenClaimCitations, type FlatCitation } from "./citation-utils";
import { ChatSection, type SessionInfo } from "./ChatSection";
import type { TriageStatePayload } from "./ChatDrawer";
import { ClaimList } from "./ClaimList";
import { SynthesisPanel } from "./SynthesisPanel";
import { FocusCard } from "./FocusCard";
import { PaperHeader } from "./PaperHeader";
import { PaperRail } from "./PaperRail";
import { jumpToNextUnreviewed, useTriageKeyboard } from "./keyboard";
import { claimKey, useTriageStore, type TriageStore } from "./store";
import type { TriageBackend } from "./backend";
import type { CitationResolver, ResolvedQuote } from "./citation-resolver";
import type {
  CategorySuggestion,
  Claim,
  TriageStateValue,
  VersionEntry,
  WorkspaceKey,
} from "./types";

export interface EvidenceViewerShellProps {
  /** The parsed artifact for the currently selected version. */
  artifact: CategorySuggestion | null;
  paperIdMapping: PaperIdMapping;

  /** Available versions for the dropdown. v0 = pipeline output, v1+ = edit drafts. */
  versions: VersionEntry[];
  selectedVersion: number;
  onVersionChange(version: number): void;

  /** Triage persistence + workspace identity. */
  backend: TriageBackend;
  workspaceKey: WorkspaceKey;
  /** Display attribution for paper-done events. */
  user: string;

  /**
   * Mint a chat session for the given artifact version. Lazy: called on
   * the first user gesture that needs a session (chat open, rewrite). The
   * shell uses the returned `chatUrl` + `sessionId` + `token` to attach
   * the chat transport.
   */
  chatSessionFactory: (input: { version: number }) => Promise<SessionInfo>;
  /**
   * Fired after a chat turn that wrote a new draft version. Consumer
   * refetches its versions list and bumps `selectedVersion` to the new
   * value. The shell then re-binds (the existing session has rolled
   * forward server-side; the next user gesture sees the new version).
   */
  onArtifactWrite?(write: { version: number; parentVersion: number }): void;
  /**
   * If supplied, the shell renders a Rewrite button in its footer that
   * sends this prompt as a scripted chat message. If omitted, no button
   * is rendered.
   */
  rewritePrompt?: string;

  /** Resolves chat-introduced citations to PDF bbox positions on demand. */
  resolveCitations: CitationResolver;

  /** PDF rendering inputs. */
  pdfUrlForDoi(doi: string): string;
  pdfWorkerSrc: string;
  pdfCMapUrl: string;
  /**
   * Markdown rendering input. Optional: Markdown viewing is additive over the
   * required PDF baseline, so omitting it keeps the evidence panel PDF-only and
   * hides the PDF/MD toggle. When provided, a citation that resolved a
   * the assembled markdown anchor can be highlighted in the assembled Markdown.
   */
  markdownUrlForDoi?(doi: string): string;

  /** Optional consumer-supplied footer slot (e.g. download / accept / reject). */
  commitSlot?: ReactNode;
  /** Deep-link target resolved on load to (paperId, claimIndex). */
  initialFocusTarget?: { paperId: string; quote: string } | null;
  /** Forwarded for cross-window deep-linking (chat-introduced citations). */
  onCitationClick?(parsed: { paperId: string; quote: string }): void;
  /** When true, hides chat surface + Rewrite affordance. */
  readOnly?: boolean;

  /** Title bar text. Defaults to a generic "Evidence Viewer". */
  categoryName?: string;
}

function buildVersionLabel(v: VersionEntry): string {
  const base = v.version === 0 ? "v0 (Pipeline)" : `v${v.version}`;
  if (v.parentVersion != null) return `${base} ← v${v.parentVersion}`;
  return base;
}

/** Key for the pending-resolution set. Newline can't appear in a DOI. */
function resolutionKey(doi: string, quote: string): string {
  return `${doi}\n${quote}`;
}

const REWRITE_DEFAULT_PROMPT =
  "Apply my triage decisions and rewrite the notes and description using only the accepted claims. Re-rank papers and claims accordingly.";

export function EvidenceViewerShell({
  artifact,
  paperIdMapping,
  versions,
  selectedVersion,
  onVersionChange,
  backend,
  workspaceKey,
  user,
  chatSessionFactory,
  onArtifactWrite,
  rewritePrompt,
  resolveCitations,
  pdfUrlForDoi,
  pdfWorkerSrc,
  pdfCMapUrl,
  markdownUrlForDoi,
  commitSlot,
  initialFocusTarget = null,
  onCitationClick,
  readOnly = false,
  categoryName,
}: EvidenceViewerShellProps) {
  // ── Derived structure from the parsed artifact ────────────────────
  const papers = useMemo(() => artifact?.papers ?? [], [artifact?.papers]);
  const claimsByPaper = useMemo(
    () => groupClaimsByPaper(artifact?.claims ?? []),
    [artifact?.claims],
  );
  const paperIds = useMemo(() => papers.map((p) => p.paperId), [papers]);
  const flatCitations = useMemo<FlatCitation[]>(
    () => (artifact ? flattenClaimCitations(artifact, paperIdMapping) : []),
    [artifact, paperIdMapping],
  );

  // ── Triage store ───────────────────────────────────────────────────
  const claimStates = useTriageStore((s) => s.claimStates);
  const papersDone = useTriageStore((s) => s.papersDone);
  const comments = useTriageStore((s) => s.comments);
  const focusedPaperId = useTriageStore((s) => s.focusedPaperId);
  const focusedClaimIndex = useTriageStore((s) => s.focusedClaimIndex);
  const loadFromServer = useTriageStore((s) => s.loadFromServer);
  const applyClaimState = useTriageStore((s) => s.applyClaimState);
  const applyPaperDone = useTriageStore((s) => s.applyPaperDone);
  const applyClaimComment = useTriageStore((s) => s.applyClaimComment);
  const focusClaim = useTriageStore((s) => s.focusClaim);
  const focusPaper = useTriageStore((s) => s.focusPaper);
  const reset = useTriageStore((s) => s.reset);

  // Triage is "ready" once the backend snapshot for the current workspace
  // has populated the store. Mutations fire setClaimState/etc. against
  // workspaceKey; acting before the load lands races with whatever
  // initialisation the backend is doing.
  const storeWorkspaceKey = useTriageStore((s: TriageStore) => s.workspaceKey);
  const triageReady =
    storeWorkspaceKey != null &&
    JSON.stringify(storeWorkspaceKey) === JSON.stringify(workspaceKey);

  const [loadError, setLoadError] = useState<string | null>(null);

  // Seed the triage store on mount and whenever the workspaceKey changes
  // (a version switch counts). Only run once the artifact for this version
  // has arrived — otherwise the initial-focus resolution below has no
  // claims to resolve against.
  const artifactLoaded = !!artifact;
  const workspaceKeyJson = useMemo(
    () => JSON.stringify(workspaceKey),
    [workspaceKey],
  );
  useEffect(() => {
    if (!artifactLoaded) return;
    let cancelled = false;
    setLoadError(null);
    (async () => {
      try {
        const snap = await backend.load(workspaceKey);
        if (cancelled) return;
        loadFromServer({
          workspaceKey,
          claims: snap.claims,
          papers: snap.papers,
          comments: snap.comments,
        });
        if (!artifact) return;
        // The snapshot load is async; the curator may have clicked a paper
        // or claim while it was in flight. Their explicit selection wins —
        // computing an initial focus here would yank the cursor back to the
        // first unreviewed claim, and because the Accept/Reject buttons are
        // gated on `triageReady`, a pending click would then land on the
        // wrong claim.
        if (useTriageStore.getState().focusedPaperId != null) return;
        let initialPaper: string | null = null;
        let initialClaim: number | null = null;
        if (initialFocusTarget) {
          const resolved = resolveClaimForCitation(
            initialFocusTarget.paperId,
            initialFocusTarget.quote,
            artifact.claims,
          );
          if (resolved) {
            initialPaper = resolved.paperId;
            initialClaim = resolved.claimIndex;
          }
        }
        if (!initialPaper) {
          const firstPaper = papers[0]?.paperId;
          if (firstPaper) {
            const group = claimsByPaper.get(firstPaper) ?? [];
            const firstUnreviewed = group.findIndex(
              (_, i) =>
                (snap.claims.find(
                  (c) => c.paperId === firstPaper && c.claimIndex === i + 1,
                )?.state ?? "UNREVIEWED") === "UNREVIEWED",
            );
            initialPaper = firstPaper;
            initialClaim = firstUnreviewed >= 0 ? firstUnreviewed + 1 : 1;
          }
        }
        if (initialPaper && initialClaim) {
          focusClaim(initialPaper, initialClaim);
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
      reset();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceKeyJson, artifactLoaded]);

  // ── Focus state helpers ───────────────────────────────────────────
  const focusedClaim: Claim | null = useMemo(() => {
    if (!focusedPaperId || !focusedClaimIndex) return null;
    const group = claimsByPaper.get(focusedPaperId) ?? [];
    return group[focusedClaimIndex - 1] ?? null;
  }, [focusedPaperId, focusedClaimIndex, claimsByPaper]);

  const [quoteIndex, setQuoteIndex] = useState(0);

  // ── Resolved bboxes + anchors for chat-introduced citations ───────
  const [resolvedQuotes, setResolvedQuotes] = useState<
    Record<string, Record<string, ResolvedQuote>>
  >({});
  // Quotes whose resolution round-trip is in flight, keyed `${doi}\n${quote}`.
  // Lets the evidence panel show "locating…" instead of "could not locate"
  // while we wait for the resolver.
  const [pendingResolutions, setPendingResolutions] = useState<Set<string>>(
    () => new Set(),
  );
  const resolvedForVersion = useRef(-1);
  useEffect(() => {
    if (!artifact || selectedVersion === resolvedForVersion.current) return;
    resolvedForVersion.current = selectedVersion;
    const toResolve = new Map<string, Set<string>>();
    for (const citation of flatCitations) {
      // Skip citations the pipeline already resolved; only chat-introduced
      // quotes (no location) need the resolver.
      if (citation.location) continue;
      if (resolvedQuotes[citation.doi]?.[citation.quote]) continue;
      const existing = toResolve.get(citation.doi) ?? new Set();
      existing.add(citation.quote);
      toResolve.set(citation.doi, existing);
    }
    if (toResolve.size === 0) return;
    const citationsToResolve = [...toResolve].map(([doi, quotes]) => ({
      doi,
      quotes: [...quotes],
    }));
    const pendingKeys = citationsToResolve.flatMap(({ doi, quotes }) =>
      quotes.map((q) => resolutionKey(doi, q)),
    );
    setPendingResolutions((prev) => new Set([...prev, ...pendingKeys]));
    void (async () => {
      try {
        const result = await resolveCitations(citationsToResolve);
        setResolvedQuotes((prev) => {
          const next = { ...prev };
          for (const [doi, quotes] of Object.entries(result.resolved)) {
            next[doi] = { ...next[doi], ...quotes };
          }
          return next;
        });
      } catch (err) {
        console.error("[viewer] citation resolution failed", err);
      } finally {
        setPendingResolutions((prev) => {
          const next = new Set(prev);
          for (const k of pendingKeys) next.delete(k);
          return next;
        });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifact, selectedVersion]);

  // ── Evidence panel state ──────────────────────────────────────────
  const [chatOverrideCitation, setChatOverrideCitation] = useState<{
    doi: string;
    quote: string;
  } | null>(null);
  const [pdfZoom, setPdfZoom] = useState(1);
  // The user's explicit PDF/MD choice, tagged with the citation it applies to;
  // navigating to another citation falls back to that citation's default mode.
  const [modeOverride, setModeOverride] = useState<{
    key: string;
    mode: "pdf" | "markdown";
  } | null>(null);

  const focusedDoi = focusedPaperId
    ? (paperIdMapping.byAuthorYear[focusedPaperId]?.doi ?? null)
    : null;

  // The active (doi, quote) plus its resolved bboxes and markdown anchor — from
  // the focused pipeline citation, or the resolver cache for a chat-introduced
  // override.
  const active = useMemo(() => {
    if (chatOverrideCitation) {
      const rq =
        resolvedQuotes[chatOverrideCitation.doi]?.[chatOverrideCitation.quote];
      return {
        doi: chatOverrideCitation.doi,
        quote: chatOverrideCitation.quote,
        bboxes: rq?.bboxes ?? [],
        anchor: rq?.markdownAnchor ?? null,
      };
    }
    if (!focusedClaim) return null;
    const citation =
      focusedClaim.citations[quoteIndex] ?? focusedClaim.citations[0];
    if (!citation) return null;
    const doi = focusedDoi ?? "";
    // The pipeline citation's own location, else the resolver cache — both are
    // ResolvedQuote-shaped, so this is a single merge.
    const loc = citation.location ?? resolvedQuotes[doi]?.[citation.quote];
    return {
      doi,
      quote: citation.quote,
      bboxes: loc?.bboxes ?? [],
      anchor: loc?.markdownAnchor ?? null,
    };
  }, [
    chatOverrideCitation,
    focusedClaim,
    quoteIndex,
    focusedDoi,
    resolvedQuotes,
  ]);

  const activeDoi = active?.doi ?? "";
  const activePdfUrl = activeDoi ? pdfUrlForDoi(activeDoi) : "";

  const pdfHighlights: PdfHighlight[] = useMemo(() => {
    if (!active) return [];
    const pending =
      active.bboxes.length === 0 &&
      pendingResolutions.has(resolutionKey(active.doi, active.quote));
    return [{ bboxes: active.bboxes, label: active.quote, pending }];
  }, [active, pendingResolutions]);

  // PDF vs Markdown for the evidence panel. The toggle is offered whenever a
  // markdown URL is available and the citation resolved at least one locator —
  // so a quote found in only one source (e.g. supplement-only, or a PDF text
  // layer the anchor couldn't match) can still be viewed in the other, with
  // that viewer showing the document plus a "could not locate here" warning
  // instead of trapping the curator in one view. The default mode prefers PDF,
  // falling back to Markdown when only an anchor resolved.
  const canMarkdown = !!markdownUrlForDoi;
  const hasBboxes = (active?.bboxes.length ?? 0) > 0;
  const hasAnchor = active?.anchor != null;
  const activeKey = active ? resolutionKey(active.doi, active.quote) : "";
  const defaultMode: "pdf" | "markdown" =
    !hasBboxes && hasAnchor && canMarkdown ? "markdown" : "pdf";
  const evidenceMode: "pdf" | "markdown" =
    canMarkdown && modeOverride?.key === activeKey
      ? modeOverride.mode
      : defaultMode;
  const canToggleMode = canMarkdown && (hasBboxes || hasAnchor);
  const markdownPending =
    active != null &&
    active.anchor == null &&
    pendingResolutions.has(resolutionKey(active.doi, active.quote));

  // ── Triage actions ────────────────────────────────────────────────
  /**
   * Reconcile the paper-done flag with the current claim states.
   *
   * - All claims decided AND not done → auto-mark done; jump to the next
   *   unreviewed claim across papers.
   * - Any claim back to UNREVIEWED AND currently done → auto-unmark.
   *   This is the load-bearing half: without it, un-accepting a claim
   *   leaves a stale "done" flag, and chat-service treats the paper as
   *   triaged-empty (curator finished, accepted nothing) and drops it.
   */
  function reconcilePaperDone(paperId: string) {
    const state = useTriageStore.getState();
    const group = claimsByPaper.get(paperId) ?? [];
    if (group.length === 0) return;
    const allDecided = group.every((_, i) => {
      const s = state.claimStates[claimKey(paperId, i + 1)];
      return s != null && s !== "UNREVIEWED";
    });
    const isDone = state.papersDone[paperId] != null;

    if (allDecided && !isDone) {
      applyPaperDone(paperId, true, user);
      backend.setPaperDone(workspaceKey, paperId, true, user).catch(() => {
        applyPaperDone(paperId, false, user);
      });
      jumpToNextUnreviewed(
        paperIds,
        claimsByPaper,
        useTriageStore.getState().claimStates,
        paperId,
        group.length,
        1,
        focusClaim,
      );
    } else if (!allDecided && isDone) {
      applyPaperDone(paperId, false, user);
      backend.setPaperDone(workspaceKey, paperId, false, user).catch(() => {
        applyPaperDone(paperId, true, user);
      });
    }
  }

  function advanceToNextUnreviewedInPaper(curPaper: string, curIndex: number) {
    const group = claimsByPaper.get(curPaper) ?? [];
    const states = useTriageStore.getState().claimStates;
    for (let i = curIndex + 1; i <= group.length; i++) {
      const k = claimKey(curPaper, i);
      if ((states[k] ?? "UNREVIEWED") === "UNREVIEWED") {
        focusClaim(curPaper, i);
        setQuoteIndex(0);
        return;
      }
    }
    for (let i = 1; i < curIndex; i++) {
      const k = claimKey(curPaper, i);
      if ((states[k] ?? "UNREVIEWED") === "UNREVIEWED") {
        focusClaim(curPaper, i);
        setQuoteIndex(0);
        return;
      }
    }
  }

  const handleTriageAccept = useCallback(
    (paperId: string, claimIndex: number) => {
      if (!triageReady) return;
      const group = claimsByPaper.get(paperId) ?? [];
      const claim = group[claimIndex - 1];
      if (!claim) return;
      const prevState =
        useTriageStore.getState().claimStates[claimKey(paperId, claimIndex)] ??
        "UNREVIEWED";
      const newState: TriageStateValue =
        prevState === "ACCEPTED" ? "UNREVIEWED" : "ACCEPTED";
      const reverted = applyClaimState(paperId, claimIndex, newState);
      backend
        .setClaimState(workspaceKey, paperId, claimIndex, newState)
        .catch(() => applyClaimState(paperId, claimIndex, reverted));
      if (newState !== "UNREVIEWED") {
        advanceToNextUnreviewedInPaper(paperId, claimIndex);
      }
      reconcilePaperDone(paperId);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [triageReady, claimsByPaper, workspaceKeyJson],
  );

  const handleTriageReject = useCallback(
    (paperId: string, claimIndex: number) => {
      if (!triageReady) return;
      const group = claimsByPaper.get(paperId) ?? [];
      const claim = group[claimIndex - 1];
      if (!claim) return;
      const prevState =
        useTriageStore.getState().claimStates[claimKey(paperId, claimIndex)] ??
        "UNREVIEWED";
      const newState: TriageStateValue =
        prevState === "REJECTED" ? "UNREVIEWED" : "REJECTED";
      const reverted = applyClaimState(paperId, claimIndex, newState);
      backend
        .setClaimState(workspaceKey, paperId, claimIndex, newState)
        .catch(() => applyClaimState(paperId, claimIndex, reverted));
      if (newState !== "UNREVIEWED") {
        advanceToNextUnreviewedInPaper(paperId, claimIndex);
      }
      reconcilePaperDone(paperId);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [triageReady, claimsByPaper, workspaceKeyJson],
  );

  const handlePaperToggleDone = useCallback(
    (paperId: string) => {
      if (!triageReady) return;
      const wasDone = papersDone[paperId] != null;
      applyPaperDone(paperId, !wasDone, user);
      backend
        .setPaperDone(workspaceKey, paperId, !wasDone, user)
        .catch(() => applyPaperDone(paperId, wasDone, user));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [triageReady, papersDone, workspaceKeyJson, user],
  );

  const handleCommentSave = useCallback(
    async (paperId: string, claimIndex: number, body: string) => {
      if (!triageReady) return;
      const claim = claimsByPaper.get(paperId)?.[claimIndex - 1];
      if (!claim) return;
      const prev = applyClaimComment(paperId, claimIndex, body);
      try {
        await backend.setClaimComment(workspaceKey, paperId, claimIndex, body);
      } catch (err) {
        applyClaimComment(paperId, claimIndex, prev);
        throw err;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [triageReady, claimsByPaper, workspaceKeyJson],
  );

  // ── Triage-state snapshot for chat requests ───────────────────────
  const buildTriageState = useCallback((): TriageStatePayload => {
    const state = useTriageStore.getState();
    const accepted: { paper_id: string; claim_index: number }[] = [];
    const rejected: { paper_id: string; claim_index: number }[] = [];
    const commentsList: {
      paper_id: string;
      claim_index: number;
      body: string;
    }[] = [];
    for (const [key, s] of Object.entries(state.claimStates)) {
      const [paperId, idxStr] = key.split("\n");
      const claim_index = Number(idxStr);
      if (s === "ACCEPTED") accepted.push({ paper_id: paperId!, claim_index });
      else if (s === "REJECTED")
        rejected.push({ paper_id: paperId!, claim_index });
    }
    for (const [key, body] of Object.entries(state.comments)) {
      const [paperId, idxStr] = key.split("\n");
      commentsList.push({
        paper_id: paperId!,
        claim_index: Number(idxStr),
        body,
      });
    }
    return {
      version_id: `${workspaceKeyJson}/v${selectedVersion}`,
      accepted,
      rejected,
      papers_done: Object.keys(state.papersDone),
      comments: commentsList,
    };
  }, [workspaceKeyJson, selectedVersion]);

  // ── Chat session lifecycle ────────────────────────────────────────
  const [session, setSession] = useState<SessionInfo | null>(null);
  const sessionVersion = useRef<number | null>(null);
  const sessionInflight = useRef<Promise<SessionInfo> | null>(null);

  const ensureSession = useCallback(async (): Promise<SessionInfo> => {
    if (session && sessionVersion.current === selectedVersion) return session;
    if (sessionInflight.current) return sessionInflight.current;
    const inflight = (async () => {
      const result = await chatSessionFactory({ version: selectedVersion });
      setSession(result);
      sessionVersion.current = selectedVersion;
      return result;
    })();
    sessionInflight.current = inflight;
    try {
      return await inflight;
    } finally {
      sessionInflight.current = null;
    }
  }, [session, selectedVersion, chatSessionFactory]);

  // Eagerly create the session once per selected version (in edit mode).
  // Single attempt per version: silently re-firing on every render is a
  // retry storm waiting to happen.
  const attemptedForVersion = useRef<number | null>(null);
  useEffect(() => {
    if (readOnly || !artifact) return;
    if (session && sessionVersion.current === selectedVersion) return;
    if (attemptedForVersion.current === selectedVersion) return;
    attemptedForVersion.current = selectedVersion;
    void ensureSession().catch(() => {
      /* errors surfaced when the user interacts with chat */
    });
  }, [readOnly, artifact, session, selectedVersion, ensureSession]);

  // ── Chat drawer / rewrite state ───────────────────────────────────
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [rewriteInProgress, setRewriteInProgress] = useState(false);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);

  const handleMessageFinish = useCallback(
    (write: { version: number; parent_version: number } | null) => {
      try {
        if (write) {
          // Mirror chat-service's session.artifactVersion roll-forward
          // locally so the ensure-session guard keeps the chat thread
          // attached across the version bump.
          sessionVersion.current = write.version;
          setChatOverrideCitation(null);
          onArtifactWrite?.({
            version: write.version,
            parentVersion: write.parent_version,
          });
        }
      } finally {
        setRewriteInProgress(false);
      }
    },
    [onArtifactWrite],
  );

  const sendRewrite = useCallback(async () => {
    if (readOnly) return;
    setChatOpen(true);
    setRewriteInProgress(true);
    try {
      await ensureSession();
      setPendingPrompt(rewritePrompt ?? REWRITE_DEFAULT_PROMPT);
    } catch {
      setRewriteInProgress(false);
    }
  }, [readOnly, ensureSession, rewritePrompt]);

  const handleOpenChat = useCallback(async () => {
    if (readOnly) return;
    const prefill = focusedClaim
      ? `About this claim from ${focusedClaim.paperId} ("${focusedClaim.text}"): `
      : "";
    if (prefill && !chatInput) setChatInput(prefill);
    setChatOpen(true);
    requestAnimationFrame(() => {
      const el = chatInputRef.current;
      if (!el) return;
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
    });
    try {
      await ensureSession();
    } catch {
      /* surfaced via the chat drawer's error alert */
    }
  }, [readOnly, focusedClaim, chatInput, ensureSession]);

  // ── Citation click from Description / Notes / chat ────────────────
  const handleCitationClickInternal = useCallback(
    ({ paperId, quote }: { paperId: string; quote: string }) => {
      const entry = paperIdMapping.byAuthorYear[paperId];
      if (!entry) return;
      if (!artifact) return;
      const resolved = resolveClaimForCitation(paperId, quote, artifact.claims);
      if (resolved) {
        setChatOverrideCitation(null);
        focusClaim(resolved.paperId, resolved.claimIndex);
        const group = claimsByPaper.get(resolved.paperId) ?? [];
        const claim = group[resolved.claimIndex - 1];
        if (claim) {
          const qi = claim.citations.findIndex((c) => c.quote === quote);
          setQuoteIndex(qi >= 0 ? qi : 0);
        }
        onCitationClick?.({ paperId, quote });
        return;
      }
      // Citation didn't match any artifact claim — chat-introduced.
      setChatOverrideCitation({ doi: entry.doi, quote });
      onCitationClick?.({ paperId, quote });
    },
    [paperIdMapping, artifact, claimsByPaper, focusClaim, onCitationClick],
  );

  // ── Keyboard shortcuts ────────────────────────────────────────────
  const commentTextareaRef = useRef<HTMLTextAreaElement>(null);
  useTriageKeyboard({
    papers: paperIds,
    claimsByPaper,
    onAccept: handleTriageAccept,
    onReject: handleTriageReject,
    onOpenComment: () => {
      commentTextareaRef.current?.focus();
    },
    onOpenChat: handleOpenChat,
    onCycleQuote: () => {
      if (!focusedClaim) return;
      setQuoteIndex(
        (i) => (i + 1) % Math.max(1, focusedClaim.citations.length),
      );
    },
  });

  // ── Document title ────────────────────────────────────────────────
  const titleParts: string[] = ["Evidence Viewer"];
  if (categoryName) titleParts.push(categoryName);
  const title = titleParts.join(" — ");
  useEffect(() => {
    if (typeof document !== "undefined") document.title = title;
  }, [title]);

  // ── Render guards ─────────────────────────────────────────────────
  if (!artifact) {
    return (
      <div className="flex h-full items-center justify-center">
        <Stack align="center" gap="sm">
          <Loader size="md" />
          <Text size="sm" c="dimmed">
            Loading artifact…
          </Text>
        </Stack>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center">
        <Alert
          icon={<IconAlertCircle size={16} />}
          color="red"
          className="max-w-md"
        >
          Couldn&rsquo;t load triage state: {loadError}
        </Alert>
      </div>
    );
  }

  const focusedRank =
    focusedPaperId != null ? paperIds.indexOf(focusedPaperId) + 1 : 0;
  const focusedRankRationale = focusedPaperId
    ? (papers.find((p) => p.paperId === focusedPaperId)?.rankRationale ?? "")
    : "";
  const triagedCount = Object.values(claimStates).filter(
    (s) => s === "ACCEPTED" || s === "REJECTED",
  ).length;
  const versionOptions = versions.map((v) => ({
    value: String(v.version),
    label: buildVersionLabel(v),
  }));

  return (
    <div className="flex h-full flex-col">
      <div className="border-b bg-gray-50 px-4 py-2">
        <Text size="sm" fw={600} className="text-gray-700">
          {title}
        </Text>
      </div>

      <div
        className="flex min-h-0 flex-1"
        data-testid="triage-panel"
        data-version={selectedVersion}
      >
        <div className="flex w-1/2 shrink-0 flex-col overflow-hidden border-r border-gray-200">
          <div className="flex min-h-0 flex-1">
            <PaperRail
              papers={papers}
              claimsByPaper={claimsByPaper}
              claimStates={claimStates}
              papersDone={papersDone}
              focusedPaperId={focusedPaperId}
              onFocusPaper={focusPaper}
            />

            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
              {focusedPaperId && (
                <PaperHeader
                  paperId={focusedPaperId}
                  rank={focusedRank}
                  rankRationale={focusedRankRationale}
                  done={papersDone[focusedPaperId] != null}
                  reviewed={(claimsByPaper.get(focusedPaperId) ?? []).reduce(
                    (sum, _, i) => {
                      const s =
                        claimStates[claimKey(focusedPaperId, i + 1)] ??
                        "UNREVIEWED";
                      return s === "UNREVIEWED" ? sum : sum + 1;
                    },
                    0,
                  )}
                  total={(claimsByPaper.get(focusedPaperId) ?? []).length}
                  onToggleDone={() => handlePaperToggleDone(focusedPaperId)}
                  paperIdMapping={paperIdMapping}
                  disabled={!triageReady}
                />
              )}

              <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
                {!paperIds.length && (
                  <div
                    className="rounded border-2 border-gray-200 bg-gray-50 p-4 text-center"
                    data-testid="no-claims-placeholder"
                  >
                    <Text size="sm" c="dimmed">
                      No claims
                    </Text>
                  </div>
                )}
                {focusedClaim &&
                  focusedPaperId &&
                  focusedClaimIndex != null && (
                    <>
                      <FocusCard
                        paperId={focusedPaperId}
                        claimIndex={focusedClaimIndex}
                        claim={focusedClaim}
                        state={
                          claimStates[
                            claimKey(focusedPaperId, focusedClaimIndex)
                          ] ?? "UNREVIEWED"
                        }
                        comment={
                          comments[
                            claimKey(focusedPaperId, focusedClaimIndex)
                          ] ?? ""
                        }
                        paperClaimTotal={
                          (claimsByPaper.get(focusedPaperId) ?? []).length
                        }
                        quoteIndex={quoteIndex}
                        onCycleQuote={() =>
                          setQuoteIndex(
                            (i) =>
                              (i + 1) %
                              Math.max(1, focusedClaim.citations.length),
                          )
                        }
                        onAccept={() =>
                          handleTriageAccept(focusedPaperId, focusedClaimIndex)
                        }
                        onReject={() =>
                          handleTriageReject(focusedPaperId, focusedClaimIndex)
                        }
                        onAsk={handleOpenChat}
                        onSaveComment={handleCommentSave}
                        commentTextareaRef={commentTextareaRef}
                        readOnly={readOnly}
                        disabled={!triageReady}
                      />
                      <ClaimList
                        paperId={focusedPaperId}
                        claims={claimsByPaper.get(focusedPaperId) ?? []}
                        focusedClaimIndex={focusedClaimIndex}
                        claimStates={claimStates}
                        onFocus={(i) => {
                          focusClaim(focusedPaperId, i);
                          setQuoteIndex(0);
                        }}
                      />
                    </>
                  )}

                <SynthesisPanel
                  description={artifact.description}
                  notes={artifact.notes}
                  paperIdMapping={paperIdMapping}
                  onCitationClick={handleCitationClickInternal}
                />
              </div>
            </div>
          </div>

          {!readOnly && session && (
            <ChatSection
              session={session}
              paperIdMapping={paperIdMapping}
              getTriageState={buildTriageState}
              isOpen={chatOpen}
              onOpenChange={setChatOpen}
              input={chatInput}
              onInputChange={setChatInput}
              pendingPrompt={pendingPrompt}
              onPendingPromptCleared={() => setPendingPrompt(null)}
              onMessageFinish={handleMessageFinish}
              disabled={rewriteInProgress}
              inputRef={chatInputRef}
            />
          )}
        </div>

        <div className="flex w-1/2 flex-col">
          {activeDoi ? (
            <>
              {canToggleMode && (
                <div className="flex justify-center border-b border-gray-200 bg-gray-50 px-2 py-1">
                  <SegmentedControl
                    size="xs"
                    value={evidenceMode}
                    onChange={(value) =>
                      setModeOverride({
                        key: activeKey,
                        mode: value === "markdown" ? "markdown" : "pdf",
                      })
                    }
                    data={[
                      { label: "PDF", value: "pdf" },
                      { label: "Markdown", value: "markdown" },
                    ]}
                    data-testid="evidence-mode-toggle"
                  />
                </div>
              )}
              <div className="min-h-0 flex-1">
                {evidenceMode === "markdown" && markdownUrlForDoi ? (
                  <MarkdownHighlightViewer
                    markdownUrl={markdownUrlForDoi(activeDoi)}
                    anchor={active?.anchor ?? null}
                    label={active?.quote}
                    pending={markdownPending}
                  />
                ) : activePdfUrl ? (
                  <PdfHighlightViewer
                    pdfUrl={activePdfUrl}
                    highlights={pdfHighlights}
                    zoom={pdfZoom}
                    onZoomChange={setPdfZoom}
                    workerSrc={pdfWorkerSrc}
                    cMapUrl={pdfCMapUrl}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-gray-500">
                    Loading PDF…
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex h-full items-center justify-center text-gray-400">
              Select a claim to view the source PDF
            </div>
          )}
        </div>
      </div>

      {/* Footer: version dropdown + optional Rewrite + commitSlot */}
      <div
        className="flex items-center gap-3 border-t border-gray-200 bg-gray-50 px-4 py-2"
        data-testid="viewer-footer"
      >
        {versionOptions.length > 0 && (
          <Select
            data={versionOptions}
            value={String(selectedVersion)}
            onChange={(value) => {
              if (!value) return;
              const v = Number.parseInt(value, 10);
              if (!Number.isFinite(v) || v === selectedVersion) return;
              setChatOverrideCitation(null);
              setSession(null);
              sessionVersion.current = null;
              attemptedForVersion.current = null;
              onVersionChange(v);
            }}
            disabled={rewriteInProgress}
            data-testid="version-select"
            size="xs"
            allowDeselect={false}
          />
        )}
        {!readOnly && (
          <Button
            size="xs"
            variant="default"
            onClick={() => void sendRewrite()}
            disabled={
              rewriteInProgress ||
              artifact.claims.length === 0 ||
              triagedCount === 0
            }
            data-testid="rewrite-button"
          >
            {rewriteInProgress ? "Rewriting…" : "Rewrite"}
          </Button>
        )}
        <div className="flex-1" />
        {commitSlot}
      </div>
    </div>
  );
}
