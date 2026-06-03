// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { EvidenceViewerShell } from "./EvidenceViewerShell";
import { useTriageStore } from "./store";
import type { PaperIdMapping } from "../citations/types";
import type {
  CategorySuggestion,
  TriageStateValue,
  VersionEntry,
  WorkspaceKey,
} from "./types";
import type { TriageBackend, TriageSnapshotPayload } from "./backend";
import type { CitationResolver } from "./citation-resolver";
import type { SessionInfo } from "./ChatSection";

// happy-dom does not implement ResizeObserver; stub it so PdfHighlightViewer mounts.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  globalThis.ResizeObserver =
    ResizeObserverStub as unknown as typeof ResizeObserver;
  // happy-dom lacks scrollIntoView; the Markdown viewer calls it post-render.
  Element.prototype.scrollIntoView = vi.fn();
  vi.doMock("react-pdf", () => ({
    pdfjs: { GlobalWorkerOptions: {} },
    Document: () => null,
    Page: () => null,
  }));
});

afterEach(() => {
  useTriageStore.getState().reset();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

/** `/api/papers/{doi}/markdown`-style resolver for the markdown viewer. */
const mdUrl = (doi: string) =>
  `https://example.test/${encodeURIComponent(doi)}.md`;

const MAPPING: PaperIdMapping = {
  byAuthorYear: {
    Smith2024: { doi: "10.1234/smith.2024" },
    Jones2023: { doi: "10.1234/jones.2023" },
  },
  byDoi: {
    "10.1234/smith.2024": "Smith2024",
    "10.1234/jones.2023": "Jones2023",
  },
};

const ARTIFACT: CategorySuggestion = {
  category: "acmg_classification",
  description: "Description.",
  notes: "Notes.",
  papers: [
    { paperId: "Smith2024", rankRationale: "Functional." },
    { paperId: "Jones2023", rankRationale: "Clinical." },
  ],
  claims: [
    {
      paperId: "Smith2024",
      text: "Functional claim 1",
      citations: [
        {
          quote: "func quote",
          location: {
            bboxes: [{ page: 1, top: 100, left: 100, bottom: 200, right: 200 }],
            markdownAnchor: null,
          },
        },
      ],
    },
    {
      paperId: "Smith2024",
      text: "Functional claim 2",
      citations: [{ quote: "second func quote" }],
    },
    {
      paperId: "Jones2023",
      text: "Clinical claim",
      citations: [{ quote: "clin quote" }],
    },
  ],
};

// Same as ARTIFACT but the first (default-focused) citation resolved BOTH a PDF
// bbox and a the assembled markdown anchor — the case that earns the PDF/MD toggle.
const TOGGLE_ARTIFACT: CategorySuggestion = {
  ...ARTIFACT,
  claims: [
    {
      paperId: "Smith2024",
      text: "Functional claim 1",
      citations: [
        {
          quote: "func quote",
          location: {
            bboxes: [{ page: 1, top: 100, left: 100, bottom: 200, right: 200 }],
            markdownAnchor: { start: 5, end: 15 },
          },
        },
      ],
    },
    ...ARTIFACT.claims.slice(1),
  ],
};

// The first citation resolved ONLY a the assembled markdown anchor, no PDF bbox (a
// supplement-only quote, or a PDF text layer the anchor couldn't match). It
// defaults to Markdown but still offers the toggle so the PDF stays reachable.
const ANCHOR_ONLY_ARTIFACT: CategorySuggestion = {
  ...ARTIFACT,
  claims: [
    {
      paperId: "Smith2024",
      text: "Functional claim 1",
      citations: [
        {
          quote: "func quote in source text",
          location: { bboxes: [], markdownAnchor: { start: 6, end: 10 } },
        },
      ],
    },
    ...ARTIFACT.claims.slice(1),
  ],
};

const VERSIONS: VersionEntry[] = [
  {
    version: 0,
    parentVersion: null,
    createdAt: new Date("2026-05-07T00:00:00Z"),
    createdBy: "pipeline",
  },
];

interface MockBackend extends TriageBackend {
  loadCalls: WorkspaceKey[];
  setClaimStateCalls: Array<[WorkspaceKey, string, number, TriageStateValue]>;
  setPaperDoneCalls: Array<[WorkspaceKey, string, boolean, string]>;
}

function makeBackend(snapshot: TriageSnapshotPayload): MockBackend {
  const backend: MockBackend = {
    loadCalls: [],
    setClaimStateCalls: [],
    setPaperDoneCalls: [],
    async load(key) {
      backend.loadCalls.push(key);
      return snapshot;
    },
    async setClaimState(key, paperId, claimIndex, state) {
      backend.setClaimStateCalls.push([key, paperId, claimIndex, state]);
    },
    async setClaimComment() {
      // not exercised in these tests
    },
    async setPaperDone(key, paperId, done, user) {
      backend.setPaperDoneCalls.push([key, paperId, done, user]);
    },
  };
  return backend;
}

const NOOP_RESOLVER: CitationResolver = async () => ({
  resolved: {},
  errors: {},
});

const NEVER_SESSION: () => Promise<SessionInfo> = () => new Promise(() => {});

const baseProps = {
  paperIdMapping: MAPPING,
  versions: VERSIONS,
  selectedVersion: 0,
  workspaceKey: { variantId: "RYR2", category: "acmg", version: 0 },
  user: "alice",
  resolveCitations: NOOP_RESOLVER,
  pdfUrlForDoi: (doi: string) =>
    `https://example.test/${encodeURIComponent(doi)}.pdf`,
  pdfWorkerSrc: "/pdfjs/pdf.worker.min.mjs",
  pdfCMapUrl: "/pdfjs/cmaps/",
};

const wrap = (node: React.ReactNode) => (
  <MantineProvider>{node}</MantineProvider>
);

describe("EvidenceViewerShell", () => {
  it("renders the loading placeholder when artifact is null", () => {
    render(
      wrap(
        <EvidenceViewerShell
          {...baseProps}
          artifact={null}
          backend={makeBackend({ claims: [], papers: [], comments: [] })}
          chatSessionFactory={NEVER_SESSION}
          onVersionChange={vi.fn()}
        />,
      ),
    );
    expect(screen.getByText(/Loading artifact/)).toBeDefined();
  });

  it("loads triage snapshot on mount, focuses the first unreviewed claim, and exposes version dropdown", async () => {
    const backend = makeBackend({ claims: [], papers: [], comments: [] });
    render(
      wrap(
        <EvidenceViewerShell
          {...baseProps}
          artifact={ARTIFACT}
          backend={backend}
          chatSessionFactory={NEVER_SESSION}
          onVersionChange={vi.fn()}
        />,
      ),
    );

    // Backend.load is called with the workspace key.
    await waitFor(() => expect(backend.loadCalls.length).toBeGreaterThan(0));
    expect(backend.loadCalls[0]).toEqual(baseProps.workspaceKey);

    // After load, focus lands on (Smith2024, 1).
    await waitFor(() => {
      expect(
        screen.getByTestId("focus-card").getAttribute("data-paper-id"),
      ).toBe("Smith2024");
    });
    expect(
      screen.getByTestId("focus-card").getAttribute("data-claim-index"),
    ).toBe("1");

    // Footer renders the version dropdown.
    expect(screen.getByTestId("viewer-footer")).toBeDefined();
    expect(screen.getByTestId("version-select")).toBeDefined();
  });

  it("does not clobber a paper the curator selected while the snapshot load was in flight", async () => {
    // Defer the load so we can interleave a user click before it resolves.
    let resolveLoad!: () => void;
    const backend = makeBackend({ claims: [], papers: [], comments: [] });
    backend.load = (key) => {
      backend.loadCalls.push(key);
      return new Promise<TriageSnapshotPayload>((resolve) => {
        resolveLoad = () => resolve({ claims: [], papers: [], comments: [] });
      });
    };

    render(
      wrap(
        <EvidenceViewerShell
          {...baseProps}
          artifact={ARTIFACT}
          backend={backend}
          chatSessionFactory={NEVER_SESSION}
          onVersionChange={vi.fn()}
        />,
      ),
    );

    // The paper rail is driven by the artifact, not the triage snapshot, so
    // it is interactive while the load is still pending. Select the *second*
    // paper — the one the default initial-focus logic would never pick.
    fireEvent.click(screen.getByTestId("paper-row-Jones2023"));
    await waitFor(() =>
      expect(
        screen.getByTestId("focus-card").getAttribute("data-paper-id"),
      ).toBe("Jones2023"),
    );

    // Let the load resolve. `loadFromServer` populates the store
    // (workspaceKey set = load processed); the default focus (Smith2024, 1)
    // must not override the curator's Jones2023 selection.
    resolveLoad();
    await waitFor(() =>
      expect(useTriageStore.getState().workspaceKey).not.toBeNull(),
    );
    expect(screen.getByTestId("focus-card").getAttribute("data-paper-id")).toBe(
      "Jones2023",
    );
  });

  it("accepting a claim updates the store optimistically and fires backend.setClaimState", async () => {
    const backend = makeBackend({ claims: [], papers: [], comments: [] });
    render(
      wrap(
        <EvidenceViewerShell
          {...baseProps}
          artifact={ARTIFACT}
          backend={backend}
          chatSessionFactory={NEVER_SESSION}
          onVersionChange={vi.fn()}
        />,
      ),
    );
    await waitFor(() => expect(screen.getByTestId("focus-card")).toBeDefined());

    fireEvent.click(screen.getByTestId("accept-button"));

    await waitFor(() => {
      expect(backend.setClaimStateCalls.length).toBe(1);
    });
    const [key, paperId, claimIndex, state] = backend.setClaimStateCalls[0]!;
    expect(key).toEqual(baseProps.workspaceKey);
    expect(paperId).toBe("Smith2024");
    expect(claimIndex).toBe(1);
    expect(state).toBe("ACCEPTED");
  });

  it("reverts the optimistic update when backend.setClaimState rejects", async () => {
    const backend = makeBackend({ claims: [], papers: [], comments: [] });
    backend.setClaimState = async () => {
      throw new Error("network");
    };
    render(
      wrap(
        <EvidenceViewerShell
          {...baseProps}
          artifact={ARTIFACT}
          backend={backend}
          chatSessionFactory={NEVER_SESSION}
          onVersionChange={vi.fn()}
        />,
      ),
    );
    await waitFor(() => expect(screen.getByTestId("focus-card")).toBeDefined());

    fireEvent.click(screen.getByTestId("accept-button"));

    // After the failed setter resolves, the store reverts back to UNREVIEWED
    // for (Smith2024, 1).
    await waitFor(() => {
      const states = useTriageStore.getState().claimStates;
      expect(states["Smith2024\n1"] ?? "UNREVIEWED").toBe("UNREVIEWED");
    });
  });

  it("rewrite button is disabled until at least one claim is triaged", async () => {
    const backend = makeBackend({ claims: [], papers: [], comments: [] });
    render(
      wrap(
        <EvidenceViewerShell
          {...baseProps}
          artifact={ARTIFACT}
          backend={backend}
          chatSessionFactory={NEVER_SESSION}
          onVersionChange={vi.fn()}
        />,
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("rewrite-button")).toBeDefined(),
    );
    const btn = screen.getByTestId("rewrite-button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);

    fireEvent.click(screen.getByTestId("accept-button"));
    await waitFor(() => {
      const after = screen.getByTestId("rewrite-button") as HTMLButtonElement;
      expect(after.disabled).toBe(false);
    });
  });

  it("auto-marks a paper done when its last claim is decided", async () => {
    const backend = makeBackend({ claims: [], papers: [], comments: [] });
    render(
      wrap(
        <EvidenceViewerShell
          {...baseProps}
          artifact={ARTIFACT}
          backend={backend}
          chatSessionFactory={NEVER_SESSION}
          onVersionChange={vi.fn()}
        />,
      ),
    );
    await waitFor(() => expect(screen.getByTestId("focus-card")).toBeDefined());

    // Accept claim 1 — focus auto-advances to claim 2 of the same paper.
    fireEvent.click(screen.getByTestId("accept-button"));
    await waitFor(() => {
      expect(
        screen.getByTestId("focus-card").getAttribute("data-claim-index"),
      ).toBe("2");
    });

    // Accept claim 2 — both Smith2024 claims now decided → auto-mark done.
    fireEvent.click(screen.getByTestId("accept-button"));
    await waitFor(() => {
      const calls = backend.setPaperDoneCalls.filter(
        ([, paperId]) => paperId === "Smith2024",
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]![2]).toBe(true);
    });
    expect(useTriageStore.getState().papersDone["Smith2024"]).toBeDefined();
  });

  it("auto-unmarks a paper-done flag when a claim toggles back to UNREVIEWED", async () => {
    const backend = makeBackend({ claims: [], papers: [], comments: [] });
    render(
      wrap(
        <EvidenceViewerShell
          {...baseProps}
          artifact={ARTIFACT}
          backend={backend}
          chatSessionFactory={NEVER_SESSION}
          onVersionChange={vi.fn()}
        />,
      ),
    );
    await waitFor(() => expect(screen.getByTestId("focus-card")).toBeDefined());

    // Decide both Smith2024 claims so the paper auto-marks done.
    fireEvent.click(screen.getByTestId("accept-button"));
    await waitFor(() =>
      expect(
        screen.getByTestId("focus-card").getAttribute("data-claim-index"),
      ).toBe("2"),
    );
    fireEvent.click(screen.getByTestId("accept-button"));
    await waitFor(() => {
      expect(useTriageStore.getState().papersDone["Smith2024"]).toBeDefined();
    });

    // Re-focus Smith2024 claim 1 (the rail row).
    fireEvent.click(screen.getByTestId("paper-row-Smith2024"));
    await waitFor(() => {
      const fc = screen.getByTestId("focus-card");
      expect(fc.getAttribute("data-paper-id")).toBe("Smith2024");
      expect(fc.getAttribute("data-claim-index")).toBe("1");
    });

    // Toggle accept off → state goes back to UNREVIEWED. The paper-done
    // flag should auto-revert (so chat-service doesn't see a "triaged
    // but no claims accepted" paper and silently drop it on rewrite).
    fireEvent.click(screen.getByTestId("accept-button"));
    await waitFor(() => {
      const calls = backend.setPaperDoneCalls.filter(
        ([, paperId]) => paperId === "Smith2024",
      );
      expect(calls).toHaveLength(2);
      expect(calls[0]![2]).toBe(true);
      expect(calls[1]![2]).toBe(false);
    });
    expect(useTriageStore.getState().papersDone["Smith2024"]).toBeUndefined();
  });

  it("renders the commitSlot in the footer", async () => {
    const backend = makeBackend({ claims: [], papers: [], comments: [] });
    render(
      wrap(
        <EvidenceViewerShell
          {...baseProps}
          artifact={ARTIFACT}
          backend={backend}
          chatSessionFactory={NEVER_SESSION}
          onVersionChange={vi.fn()}
          commitSlot={<button data-testid="commit-slot-btn">Download</button>}
        />,
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("commit-slot-btn")).toBeDefined(),
    );
  });

  it("shows the PDF/MD toggle when the active citation has both a bbox and an anchor", async () => {
    const backend = makeBackend({ claims: [], papers: [], comments: [] });
    render(
      wrap(
        <EvidenceViewerShell
          {...baseProps}
          artifact={TOGGLE_ARTIFACT}
          markdownUrlForDoi={mdUrl}
          backend={backend}
          chatSessionFactory={NEVER_SESSION}
          onVersionChange={vi.fn()}
        />,
      ),
    );
    await waitFor(() => expect(screen.getByTestId("focus-card")).toBeDefined());
    await waitFor(() =>
      expect(screen.getByTestId("evidence-mode-toggle")).toBeDefined(),
    );
  });

  it("hides the toggle when no markdownUrlForDoi is provided", async () => {
    const backend = makeBackend({ claims: [], papers: [], comments: [] });
    render(
      wrap(
        <EvidenceViewerShell
          {...baseProps}
          artifact={TOGGLE_ARTIFACT}
          backend={backend}
          chatSessionFactory={NEVER_SESSION}
          onVersionChange={vi.fn()}
        />,
      ),
    );
    await waitFor(() => expect(screen.getByTestId("focus-card")).toBeDefined());
    expect(screen.queryByTestId("evidence-mode-toggle")).toBeNull();
  });

  it("still offers the toggle for a one-sided (PDF-only) citation", async () => {
    // A bbox but no anchor: the toggle stays available so the curator can switch
    // to Markdown (where the off-source viewer shows a "could not locate" note)
    // rather than being trapped in the PDF.
    const backend = makeBackend({ claims: [], papers: [], comments: [] });
    render(
      wrap(
        <EvidenceViewerShell
          {...baseProps}
          artifact={ARTIFACT}
          markdownUrlForDoi={mdUrl}
          backend={backend}
          chatSessionFactory={NEVER_SESSION}
          onVersionChange={vi.fn()}
        />,
      ),
    );
    await waitFor(() => expect(screen.getByTestId("focus-card")).toBeDefined());
    await waitFor(() =>
      expect(screen.getByTestId("evidence-mode-toggle")).toBeDefined(),
    );
  });

  it("defaults an anchor-only citation to Markdown but keeps the toggle", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            text: async () => "intro func quote in source text",
          }) as unknown as Response,
      ),
    );
    const backend = makeBackend({ claims: [], papers: [], comments: [] });
    const { container } = render(
      wrap(
        <EvidenceViewerShell
          {...baseProps}
          artifact={ANCHOR_ONLY_ARTIFACT}
          markdownUrlForDoi={mdUrl}
          backend={backend}
          chatSessionFactory={NEVER_SESSION}
          onVersionChange={vi.fn()}
        />,
      ),
    );
    // The toggle is offered even though there's no bbox…
    await waitFor(() =>
      expect(screen.getByTestId("evidence-mode-toggle")).toBeDefined(),
    );
    // …and the panel defaults to Markdown, highlighting the anchored span
    // without the curator having to toggle.
    await waitFor(() =>
      expect(container.querySelector("mark.anchor-highlight")).not.toBeNull(),
    );
  });

  it("switches the evidence panel to the Markdown viewer when toggled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            text: async () => "intro func quote in source text",
          }) as unknown as Response,
      ),
    );
    const backend = makeBackend({ claims: [], papers: [], comments: [] });
    const { container } = render(
      wrap(
        <EvidenceViewerShell
          {...baseProps}
          artifact={TOGGLE_ARTIFACT}
          markdownUrlForDoi={mdUrl}
          backend={backend}
          chatSessionFactory={NEVER_SESSION}
          onVersionChange={vi.fn()}
        />,
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("evidence-mode-toggle")).toBeDefined(),
    );

    // Defaults to PDF (the citation has bboxes); switch to Markdown.
    fireEvent.click(screen.getByText("Markdown"));

    // The Markdown viewer fetches the source and highlights the anchored span.
    await waitFor(() =>
      expect(container.querySelector("mark.anchor-highlight")).not.toBeNull(),
    );
  });
});
