import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Alert,
  Button,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import {
  IconAlertCircle,
  IconChevronRight,
  IconExternalLink,
  IconPlayerPlay,
  IconRefresh,
  IconUpload,
} from "@tabler/icons-react";
import type { PapersForVariant, PaperRow } from "@/lib/papers";
import type { LatestRunInfo } from "@/lib/runs";
import type { ProgressResponse } from "@/lib/progressEvents";
import { PaperStatusGroup } from "./PaperStatusGroup";
import { ProgressLog } from "./ProgressLog";
import { matchFilesToPapers } from "@flowajs/react-viewer";

const POLL_INTERVAL_ACTIVE_MS = 15_000;
const POLL_INTERVAL_TERMINAL_MS = 60_000;
const URL_STAGGER_MS = 1_000;

const STATUS_ORDER = [
  "extracted",
  "downloaded",
  "needs_manual",
  "queried",
  "failed",
] as const;

interface LiteratureViewProps {
  variantId: string;
}

export function LiteratureView({ variantId }: LiteratureViewProps) {
  const [papersResp, setPapersResp] = useState<PapersForVariant | null>(null);
  const [latest, setLatest] = useState<LatestRunInfo | null>(null);
  const [progress, setProgress] = useState<ProgressResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isReanalyzing, setIsReanalyzing] = useState(false);

  // The latest-run id is what we poll progress against. Once set on
  // mount (or by Re-analyze), polling is keyed off it; resets when
  // Re-analyze returns a new run_id.
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const fetchPapers = useCallback(async () => {
    const res = await fetch(
      `/api/papers?variantId=${encodeURIComponent(variantId)}`,
    );
    if (!res.ok) {
      setError(`Could not load papers (${res.status})`);
      return;
    }
    setPapersResp((await res.json()) as PapersForVariant);
  }, [variantId]);

  const fetchLatestRun = useCallback(async () => {
    const res = await fetch(
      `/api/runs/latest?variantId=${encodeURIComponent(variantId)}`,
    );
    if (res.status === 404) {
      setLatest(null);
      setActiveRunId(null);
      return;
    }
    if (!res.ok) {
      setError(`Could not look up latest run (${res.status})`);
      return;
    }
    const info = (await res.json()) as LatestRunInfo;
    setLatest(info);
    setActiveRunId(info.run_id);
  }, [variantId]);

  // Initial mount: parallel fetch papers + latest-run discovery.
  useEffect(() => {
    void Promise.all([fetchPapers(), fetchLatestRun()]);
  }, [fetchPapers, fetchLatestRun]);

  // Progress polling. Switches cadence between 15s while the run is
  // active and 60s once it terminates so the UI keeps refreshing
  // paper statuses for a bit after the pipeline finishes (catches any
  // late filesystem reads) but doesn't spam the API forever.
  // Holding the latest fetchPapers + the previous terminal flag in
  // refs lets the interval body stay stable across renders.
  const fetchPapersRef = useRef(fetchPapers);
  useEffect(() => {
    fetchPapersRef.current = fetchPapers;
  }, [fetchPapers]);

  useEffect(() => {
    if (!activeRunId) {
      setProgress(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      let body: ProgressResponse | null = null;
      try {
        const res = await fetch(
          `/api/runs/${encodeURIComponent(variantId)}/${activeRunId}/progress`,
        );
        if (cancelled) return;
        if (res.ok) {
          body = (await res.json()) as ProgressResponse;
          setProgress(body);
          await fetchPapersRef.current();
        }
      } catch {
        // Transient network error — let the next tick try again.
      }
      if (cancelled) return;
      const next =
        body?.terminal === true
          ? POLL_INTERVAL_TERMINAL_MS
          : POLL_INTERVAL_ACTIVE_MS;
      timer = setTimeout(poll, next);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeRunId, variantId]);

  const handleReanalyze = useCallback(async () => {
    if (!papersResp || !papersResp.transcript || !papersResp.hgvs_c) {
      // Without query.json there's nothing to re-submit; the button is
      // disabled in this state too, so this guard is belt-and-braces.
      return;
    }
    setIsReanalyzing(true);
    setError(null);
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: papersResp.transcript,
          hgvs_c: papersResp.hgvs_c,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        setError(`Re-analyze failed (${res.status}): ${text}`);
        return;
      }
      const triggered = (await res.json()) as {
        run_id: string;
        variant_id: string;
        started_at: string;
        status: string;
      };
      setActiveRunId(triggered.run_id);
      setLatest({
        run_id: triggered.run_id,
        started_at: triggered.started_at,
        terminal: false,
      });
      setProgress(null);
      void fetchPapers();
    } finally {
      setIsReanalyzing(false);
    }
  }, [papersResp, fetchPapers]);

  const handleSingleUpload = useCallback(
    async (paper: PaperRow, file: File) => {
      await uploadPaperPdf(paper, file);
      await fetchPapers();
    },
    [fetchPapers],
  );

  const handleSupplementUpload = useCallback(
    async (paper: PaperRow, file: File) => {
      const res = await uploadPaperSupplement(paper, file, variantId);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setError(
          `Supplement upload failed (${res.status}): ${body.error ?? "unknown error"}`,
        );
        return;
      }
      setError(null);
      // Uploading invalidates the paper's extraction server-side, so its
      // status reverts to "downloaded" until the curator re-analyzes.
      await fetchPapers();
    },
    [variantId, fetchPapers],
  );

  const handleSupplementDelete = useCallback(
    async (paper: PaperRow, filename: string) => {
      const res = await deletePaperSupplement(paper, filename, variantId);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setError(
          `Supplement delete failed (${res.status}): ${body.error ?? "unknown error"}`,
        );
        return;
      }
      setError(null);
      await fetchPapers();
    },
    [variantId, fetchPapers],
  );

  const handleBulkUpload = useCallback(
    async (files: File[]) => {
      if (!papersResp) return;
      const filesByName = new Map(files.map((f) => [f.name, f]));
      const { mains, supplements, unmatched } = matchFilesToPapers(
        files.map((f) => f.name),
        papersResp.papers,
      );
      // Mains first: a supplement's POST requires the paper's main.pdf to exist.
      for (const { filename, paper } of mains) {
        const file = filesByName.get(filename);
        if (file) await uploadPaperPdf(paper, file);
      }
      // Then supplements, in the lexicographic order the matcher returned, so
      // their ingestion ordinals follow filename order.
      for (const { filename, paper } of supplements) {
        const file = filesByName.get(filename);
        if (file) await uploadPaperSupplement(paper, file, variantId);
      }
      await fetchPapers();
      if (unmatched.length > 0) {
        setError(
          `Could not match ${unmatched.length} file(s) by PMID or encoded DOI: ${unmatched.join(", ")}`,
        );
      }
    },
    [papersResp, fetchPapers, variantId],
  );

  const handleOpenAllUrls = useCallback(() => {
    if (!papersResp) return;
    papersResp.papers.forEach((p, i) => {
      setTimeout(
        () => window.open(p.url, "_blank", "noopener"),
        i * URL_STAGGER_MS,
      );
    });
  }, [papersResp]);

  const isRunActive = latest !== null && latest.terminal === false;
  const reanalyzeLabel = latest === null ? "Analyze" : "Re-analyze";
  const hasReanalyzeContext = Boolean(
    papersResp?.transcript && papersResp?.hgvs_c,
  );
  const reanalyzeDisabledReason = isRunActive
    ? "A run is currently in flight."
    : !hasReanalyzeContext
      ? "No query.json — submit the variant from the home page first."
      : undefined;

  const groupedPapers = useMemo(() => {
    if (!papersResp) return null;
    const groups = new Map<string, PaperRow[]>();
    for (const status of STATUS_ORDER) groups.set(status, []);
    for (const p of papersResp.papers) {
      groups.get(p.status)?.push(p);
    }
    return groups;
  }, [papersResp]);

  return (
    <Stack gap="lg" data-testid="literature-view">
      <Group justify="space-between" align="flex-end">
        <div>
          <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
            Literature triage
          </Text>
          {/* Variant ids are technical identifiers; the monospace
              treatment reads as "system value" rather than free text. */}
          <Title order={2} ff="monospace">
            {variantId}
          </Title>
        </div>
        <Button
          leftSection={
            latest === null ? (
              <IconPlayerPlay size={14} />
            ) : (
              <IconRefresh size={14} />
            )
          }
          loading={isReanalyzing}
          disabled={isRunActive || !hasReanalyzeContext}
          title={reanalyzeDisabledReason}
          onClick={handleReanalyze}
        >
          {reanalyzeLabel}
        </Button>
      </Group>

      {error && (
        <Alert icon={<IconAlertCircle size={16} />} color="red">
          {error}
        </Alert>
      )}

      {papersResp &&
        papersResp.aggregateExists &&
        papersResp.categories.length > 0 && (
          <SectionPaper accentColor="teal">
            <SectionHeader title="Results" />
            <Group gap="xs">
              {papersResp.categories.map((category) => (
                <ResultCard
                  key={category}
                  variantId={variantId}
                  category={category}
                />
              ))}
            </Group>
          </SectionPaper>
        )}

      <SectionPaper accentColor="blue">
        <Group justify="space-between" align="center" mb="md">
          <SectionHeader title="Papers" noMargin />
          <Button
            variant="default"
            size="xs"
            leftSection={<IconExternalLink size={14} />}
            disabled={!papersResp || papersResp.papers.length === 0}
            onClick={handleOpenAllUrls}
          >
            Open all URLs
          </Button>
        </Group>
        {!papersResp ? (
          <Loader size="sm" />
        ) : papersResp.papers.length === 0 ? (
          <Text size="sm" c="dimmed">
            No papers yet.{" "}
            {isRunActive
              ? "Waiting for the query stage to finish…"
              : "Trigger an analysis to populate this list."}
          </Text>
        ) : (
          <Stack gap="sm">
            <BulkDropzone onFiles={handleBulkUpload} />
            {groupedPapers &&
              STATUS_ORDER.map((status) => (
                <PaperStatusGroup
                  key={status}
                  status={status}
                  papers={groupedPapers.get(status) ?? []}
                  onUpload={
                    status === "needs_manual" ? handleSingleUpload : undefined
                  }
                  onAddSupplement={
                    status === "downloaded" || status === "extracted"
                      ? handleSupplementUpload
                      : undefined
                  }
                  onDeleteSupplement={
                    status === "downloaded" || status === "extracted"
                      ? handleSupplementDelete
                      : undefined
                  }
                />
              ))}
          </Stack>
        )}
      </SectionPaper>

      <SectionPaper accentColor="indigo">
        <SectionHeader title="Progress" />
        <ProgressLog
          events={progress?.events ?? []}
          emptyMessage={
            latest === null ? "No runs yet." : "Waiting for the first event…"
          }
        />
      </SectionPaper>
    </Stack>
  );
}

interface SectionPaperProps {
  accentColor: string;
  children: React.ReactNode;
}

function SectionPaper({ accentColor, children }: SectionPaperProps) {
  return (
    <Paper
      withBorder
      p="lg"
      style={{
        borderTop: `3px solid var(--mantine-color-${accentColor}-6)`,
      }}
    >
      {children}
    </Paper>
  );
}

interface SectionHeaderProps {
  title: string;
  noMargin?: boolean;
}

function SectionHeader({ title, noMargin }: SectionHeaderProps) {
  return (
    <Title order={3} mb={noMargin ? undefined : "md"}>
      {title}
    </Title>
  );
}

interface ResultCardProps {
  variantId: string;
  category: string;
}

function ResultCard({ variantId, category }: ResultCardProps) {
  // Teal-light keeps the same colour identity the aggregate stage has
  // in the progress log, so a "result available" reads as the same
  // family as "aggregate completed" without taking a full-width bar
  // per category — chips flow horizontally and scale to N categories.
  return (
    <Button
      component={Link}
      href={`/viewer/${encodeURIComponent(variantId)}/${encodeURIComponent(category)}`}
      variant="light"
      color="teal"
      rightSection={<IconChevronRight size={14} />}
      data-testid={`result-card-${category}`}
    >
      {category}
    </Button>
  );
}

interface BulkDropzoneProps {
  onFiles(files: File[]): void;
}

function BulkDropzone({ onFiles }: BulkDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) onFiles(files);
  };

  return (
    <Paper
      withBorder
      p="sm"
      data-testid="bulk-dropzone"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      style={{
        borderStyle: "dashed",
        borderColor: "var(--mantine-color-blue-4)",
        background: dragOver
          ? "var(--mantine-color-blue-light)"
          : "var(--mantine-color-blue-0)",
      }}
    >
      <Group justify="space-between" align="center">
        <Text size="sm">
          Drop papers (<code>&lt;PMID&gt;.pdf</code> or{" "}
          <code>&lt;encoded-DOI&gt;.pdf</code>) and supplements (
          <code>&lt;id&gt;_supp.*</code>) here to bulk-upload.
        </Text>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.xlsx,.xls,.docx"
          multiple
          style={{ display: "none" }}
          data-testid="bulk-dropzone-input"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length > 0) onFiles(files);
            e.target.value = "";
          }}
        />
        <Button
          variant="default"
          size="xs"
          leftSection={<IconUpload size={12} />}
          onClick={() => inputRef.current?.click()}
        >
          Pick files
        </Button>
      </Group>
    </Paper>
  );
}

async function uploadPaperPdf(paper: PaperRow, file: File): Promise<void> {
  const formData = new FormData();
  formData.append("file", file);
  await fetch(`/api/papers/${encodeURIComponent(paper.doi)}/pdf`, {
    method: "POST",
    body: formData,
  });
}

async function uploadPaperSupplement(
  paper: PaperRow,
  file: File,
  variantId: string,
): Promise<Response> {
  const formData = new FormData();
  formData.append("file", file);
  // variantId lets the route invalidate this assessment's stale extraction.
  formData.append("variantId", variantId);
  return fetch(`/api/papers/${encodeURIComponent(paper.doi)}/supplements`, {
    method: "POST",
    body: formData,
  });
}

async function deletePaperSupplement(
  paper: PaperRow,
  filename: string,
  variantId: string,
): Promise<Response> {
  const params = new URLSearchParams({ filename, variantId });
  return fetch(
    `/api/papers/${encodeURIComponent(paper.doi)}/supplements?${params.toString()}`,
    { method: "DELETE" },
  );
}
