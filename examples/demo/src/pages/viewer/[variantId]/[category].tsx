import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/router";
import { Alert, Button, Loader, Stack, Text } from "@mantine/core";
import { IconAlertCircle, IconDownload } from "@tabler/icons-react";
import {
  EvidenceViewerShell,
  encodeDoi,
  type CategorySuggestion,
  type PaperIdMapping,
  type SessionInfo,
  type VersionEntry,
} from "@flowajs/react-viewer";
import { createTriageBackendClient } from "@/lib/triageBackendClient";
import { createCitationResolver } from "@/lib/citationResolverClient";
import { createChatSession } from "@/lib/chatSessionClient";

interface LoadedVersion {
  artifact: CategorySuggestion;
  paperIdMapping: PaperIdMapping;
  artifactText: string;
}

interface ListedVersion {
  version: number;
  createdAt: string;
}

const DEMO_USER = "demo-user";
const GATEWAY_BASE = "http://localhost:7702";
const CHAT_BASE = "http://localhost:7701";

function downloadJson(filename: string, text: string) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function ViewerPage() {
  const router = useRouter();
  const variantId =
    typeof router.query.variantId === "string" ? router.query.variantId : null;
  const category =
    typeof router.query.category === "string" ? router.query.category : null;

  const [versions, setVersions] = useState<ListedVersion[] | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<number>(0);
  const [loadedByVersion, setLoadedByVersion] = useState<
    Record<number, LoadedVersion>
  >({});
  const [error, setError] = useState<string | null>(null);

  const backend = useMemo(() => createTriageBackendClient(), []);
  const resolveCitations = useMemo(
    () => createCitationResolver({ gatewayBase: GATEWAY_BASE }),
    [],
  );

  const fetchVersions = useCallback(async () => {
    if (!variantId || !category) return;
    const res = await fetch(
      `/api/edit-drafts/${encodeURIComponent(variantId)}/${encodeURIComponent(category)}`,
    );
    if (!res.ok) {
      setError(`Could not list versions (${res.status})`);
      return;
    }
    const data = (await res.json()) as { versions: ListedVersion[] };
    setVersions(data.versions);
  }, [variantId, category]);

  const fetchVersion = useCallback(
    async (version: number) => {
      if (!variantId || !category) return;
      const res = await fetch(
        `/api/edit-drafts/${encodeURIComponent(variantId)}/${encodeURIComponent(category)}/${version}`,
      );
      if (!res.ok) {
        setError(`Could not load version v${version} (${res.status})`);
        return;
      }
      const data = (await res.json()) as LoadedVersion;
      setLoadedByVersion((prev) => ({ ...prev, [version]: data }));
    },
    [variantId, category],
  );

  // Bootstrap: list versions, then fetch v0.
  useEffect(() => {
    if (!variantId || !category) return;
    void fetchVersions();
  }, [variantId, category, fetchVersions]);

  useEffect(() => {
    if (!variantId || !category) return;
    if (loadedByVersion[selectedVersion]) return;
    void fetchVersion(selectedVersion);
  }, [variantId, category, selectedVersion, loadedByVersion, fetchVersion]);

  // After a chat-write: refetch the versions list, switch the selected
  // version, and clear the cached entry for the new version (forces refetch).
  const handleArtifactWrite = useCallback(
    async ({
      version,
      parentVersion: _parent,
    }: {
      version: number;
      parentVersion: number;
    }) => {
      await fetchVersions();
      setLoadedByVersion((prev) => {
        const next = { ...prev };
        delete next[version];
        return next;
      });
      setSelectedVersion(version);
    },
    [fetchVersions],
  );

  const loaded = loadedByVersion[selectedVersion] ?? null;

  // Hold artifactText in a ref so chatSessionFactory always reads the
  // latest value without rebinding when the cache map changes.
  const loadedRef = useRef<Record<number, LoadedVersion>>(loadedByVersion);
  useEffect(() => {
    loadedRef.current = loadedByVersion;
  }, [loadedByVersion]);

  const chatSessionFactory = useCallback(
    async ({ version }: { version: number }): Promise<SessionInfo> => {
      if (!variantId || !category) {
        throw new Error("Route params not ready");
      }
      let entry = loadedRef.current[version];
      if (!entry) {
        // Race: chat is being opened before the artifact for the version
        // has finished loading. Fetch on-demand.
        const res = await fetch(
          `/api/edit-drafts/${encodeURIComponent(variantId)}/${encodeURIComponent(category)}/${version}`,
        );
        if (!res.ok) {
          throw new Error(
            `Could not load version v${version} for chat session`,
          );
        }
        entry = (await res.json()) as LoadedVersion;
        setLoadedByVersion((prev) => ({ ...prev, [version]: entry! }));
      }
      return createChatSession(
        { chatBase: CHAT_BASE, userId: DEMO_USER },
        {
          variantId,
          category,
          version,
          artifactText: entry.artifactText,
        },
      );
    },
    [variantId, category],
  );

  const pdfUrlForDoi = useCallback(
    (doi: string) => `/api/papers/${encodeDoi(doi)}/pdf`,
    [],
  );

  const workspaceKey = useMemo(
    () => ({
      variantId: variantId ?? "",
      category: category ?? "",
      version: selectedVersion,
    }),
    [variantId, category, selectedVersion],
  );

  const versionEntries: VersionEntry[] = useMemo(
    () =>
      (versions ?? []).map((v, i, all) => ({
        version: v.version,
        parentVersion: i === 0 ? null : (all[i - 1]?.version ?? null),
        createdAt: new Date(v.createdAt),
        createdBy: null,
      })),
    [versions],
  );

  const commitSlot = loaded ? (
    <Button
      size="xs"
      variant="default"
      leftSection={<IconDownload size={14} />}
      onClick={() =>
        downloadJson(
          `${variantId ?? "variant"}-${category ?? "category"}-v${selectedVersion}.json`,
          loaded.artifactText,
        )
      }
      data-testid="download-artifact"
    >
      Download artifact JSON
    </Button>
  ) : null;

  if (!variantId || !category) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader size="md" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <Alert
          icon={<IconAlertCircle size={16} />}
          color="red"
          className="max-w-md"
        >
          {error}
        </Alert>
      </div>
    );
  }

  if (!versions || !loaded) {
    return (
      <div className="flex h-full items-center justify-center">
        <Stack align="center" gap="sm">
          <Loader size="md" />
          <Text size="sm" c="dimmed">
            Loading {variantId} / {category}…
          </Text>
        </Stack>
      </div>
    );
  }

  return (
    <div className="h-screen">
      <EvidenceViewerShell
        artifact={loaded.artifact}
        paperIdMapping={loaded.paperIdMapping}
        versions={versionEntries}
        selectedVersion={selectedVersion}
        onVersionChange={setSelectedVersion}
        backend={backend}
        workspaceKey={workspaceKey}
        user={DEMO_USER}
        chatSessionFactory={chatSessionFactory}
        onArtifactWrite={handleArtifactWrite}
        rewritePrompt="Apply my triage decisions and rewrite the notes and description using only the accepted claims. Re-rank papers and claims accordingly."
        resolveCitations={resolveCitations}
        pdfUrlForDoi={pdfUrlForDoi}
        pdfWorkerSrc="/pdfjs/pdf.worker.min.mjs"
        pdfCMapUrl="/pdfjs/cmaps/"
        commitSlot={commitSlot}
        categoryName={category}
      />
    </div>
  );
}
