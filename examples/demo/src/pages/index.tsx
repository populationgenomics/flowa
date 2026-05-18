/**
 * `/` — variant submission form + paginated runs history.
 *
 * The form takes Transcript + HGVS-c as two separate free-text fields;
 * nothing client-side is regex-validated, so an invalid input surfaces
 * as a 4xx from `/api/runs` or as a flowa runtime error on the gateway
 * side. Submit derives `variant_id` server-side and redirects to
 * `/variants/[variant_id]`.
 *
 * The history table is a paginated scan of `assessments/*\/runs/*`. No
 * SQL, no manifest — `/api/runs?page=N` does the filesystem walk.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/router";
import Link from "next/link";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Container,
  Group,
  Loader,
  Pagination,
  Paper,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { IconAlertCircle, IconPlayerPlay } from "@tabler/icons-react";
import type { RunRow, RunsHistoryPage } from "@/lib/runs";

export default function IndexPage() {
  const router = useRouter();
  const [transcript, setTranscript] = useState("");
  const [hgvsC, setHgvsC] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [page, setPage] = useState(1);
  const [history, setHistory] = useState<RunsHistoryPage | null>(null);

  const fetchHistory = useCallback(async (p: number) => {
    const res = await fetch(`/api/runs?page=${p}`);
    if (!res.ok) {
      setError(`Could not load history (${res.status})`);
      return;
    }
    setHistory((await res.json()) as RunsHistoryPage);
  }, []);

  useEffect(() => {
    void fetchHistory(page);
  }, [fetchHistory, page]);

  const onSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (!transcript.trim() || !hgvsC.trim()) {
        setError("Transcript and HGVS c. are both required.");
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        const res = await fetch("/api/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transcript: transcript.trim(),
            hgvs_c: hgvsC.trim(),
          }),
        });
        if (!res.ok) {
          const text = await res.text();
          setError(`Submission failed (${res.status}): ${text}`);
          return;
        }
        const body = (await res.json()) as { variant_id: string };
        await router.push(`/variants/${encodeURIComponent(body.variant_id)}`);
      } finally {
        setSubmitting(false);
      }
    },
    [transcript, hgvsC, router],
  );

  const totalPages = history
    ? Math.max(1, Math.ceil(history.total / history.pageSize))
    : 1;

  return (
    <Container size="md" py="lg">
      <Stack gap="xl">
        <div>
          <Title order={2}>flowa demo</Title>
          <Text size="sm" c="dimmed">
            Submit a variant to trigger an end-to-end literature assessment, or
            open a previous run from the history below.
          </Text>
        </div>

        <Paper
          withBorder
          p="lg"
          // Top accent rule matches the literature triage sections so
          // both pages share the same horizontal-card-accent vocabulary.
          style={{ borderTop: "3px solid var(--mantine-color-indigo-6)" }}
        >
          <Title order={3} mb="md">
            New analysis
          </Title>
          <form onSubmit={onSubmit}>
            <Stack>
              <TextInput
                label="Transcript"
                placeholder="e.g. NM_001035.3"
                description="RefSeq transcript identifier (gene is derived by the normaliser)"
                value={transcript}
                onChange={(e) => setTranscript(e.currentTarget.value)}
                disabled={submitting}
                data-testid="transcript-input"
              />
              <TextInput
                label="HGVS c."
                placeholder="e.g. c.14174A>G"
                description="Coding-DNA notation, c.-form only (no transcript prefix)"
                value={hgvsC}
                onChange={(e) => setHgvsC(e.currentTarget.value)}
                disabled={submitting}
                data-testid="hgvs-input"
              />
              <Group justify="flex-end">
                <Button
                  type="submit"
                  loading={submitting}
                  leftSection={<IconPlayerPlay size={14} />}
                  data-testid="submit-button"
                >
                  Analyze
                </Button>
              </Group>
            </Stack>
          </form>
        </Paper>

        {error && (
          <Alert icon={<IconAlertCircle size={16} />} color="red">
            {error}
          </Alert>
        )}

        <Paper
          withBorder
          p="lg"
          style={{ borderTop: "3px solid var(--mantine-color-teal-6)" }}
        >
          <Title order={3} mb="md">
            Run history
          </Title>
          {!history ? (
            <Loader size="sm" />
          ) : history.runs.length === 0 ? (
            <Text size="sm" c="dimmed">
              No runs yet. Submit a variant above to start one.
            </Text>
          ) : (
            <Stack gap="sm">
              <Table withTableBorder data-testid="runs-history-table">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Variant</Table.Th>
                    <Table.Th>HGVS c.</Table.Th>
                    <Table.Th>Started</Table.Th>
                    <Table.Th>Status</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {history.runs.map((row) => (
                    <RunHistoryRow key={row.run_id} row={row} />
                  ))}
                </Table.Tbody>
              </Table>
              {totalPages > 1 && (
                <Group justify="flex-end">
                  <Pagination
                    value={page}
                    total={totalPages}
                    onChange={setPage}
                  />
                </Group>
              )}
            </Stack>
          )}
        </Paper>
      </Stack>
    </Container>
  );
}

function RunHistoryRow({ row }: { row: RunRow }) {
  return (
    <Table.Tr>
      <Table.Td>
        <Anchor
          component={Link}
          href={`/variants/${encodeURIComponent(row.variant_id)}`}
        >
          <Text size="sm" ff="monospace" component="span">
            {row.variant_id}
          </Text>
        </Anchor>
      </Table.Td>
      <Table.Td>
        <Text size="sm" ff="monospace">
          {row.hgvs_c ?? "—"}
        </Text>
      </Table.Td>
      <Table.Td>
        <Text size="sm">{row.started_at ?? "—"}</Text>
      </Table.Td>
      <Table.Td>
        <Badge
          color={row.terminal ? "green" : "blue"}
          variant={row.terminal ? "light" : "filled"}
        >
          {row.terminal ? "Done" : "Running"}
        </Badge>
      </Table.Td>
    </Table.Tr>
  );
}
