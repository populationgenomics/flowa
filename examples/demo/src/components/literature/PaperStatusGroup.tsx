import { useRef } from "react";
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import {
  IconExternalLink,
  IconPaperclip,
  IconUpload,
  IconX,
} from "@tabler/icons-react";
import type { PaperRow, PaperStatus } from "@/lib/papers";

export const STATUS_LABELS: Record<PaperStatus, string> = {
  extracted: "Extracted",
  downloaded: "Downloaded",
  needs_manual: "Needs manual upload",
  queried: "Queried",
  failed: "Failed",
};

const STATUS_COLORS: Record<PaperStatus, string> = {
  extracted: "green",
  downloaded: "blue",
  needs_manual: "yellow",
  queried: "gray",
  failed: "red",
};

/** Strip the `NNN_` ingestion-order prefix supplements are stored under. */
function prettifySupplementName(filename: string): string {
  return filename.replace(/^\d{3}_/, "");
}

interface PaperStatusGroupProps {
  status: PaperStatus;
  papers: PaperRow[];
  onUpload?(paper: PaperRow, file: File): void;
  onAddSupplement?(paper: PaperRow, file: File): void;
  onDeleteSupplement?(paper: PaperRow, filename: string): void;
}

export function PaperStatusGroup({
  status,
  papers,
  onUpload,
  onAddSupplement,
  onDeleteSupplement,
}: PaperStatusGroupProps) {
  if (papers.length === 0) return null;
  const color = STATUS_COLORS[status];
  return (
    <Paper
      withBorder
      p="sm"
      data-testid={`paper-status-group-${status}`}
      // Echo the status badge as a thin rule on the left edge so the
      // colour carries down the group rather than living only on the
      // numeric badge.
      style={{ borderLeft: `4px solid var(--mantine-color-${color}-6)` }}
    >
      <Group justify="space-between" mb="xs">
        <Title order={5}>{STATUS_LABELS[status]}</Title>
        <Badge color={color} variant="light">
          {papers.length}
        </Badge>
      </Group>
      <Stack gap="xs">
        {papers.map((p) => (
          <PaperRowItem
            key={p.doi}
            paper={p}
            onUpload={onUpload ? (file) => onUpload(p, file) : undefined}
            onAddSupplement={
              onAddSupplement ? (file) => onAddSupplement(p, file) : undefined
            }
            onDeleteSupplement={
              onDeleteSupplement
                ? (filename) => onDeleteSupplement(p, filename)
                : undefined
            }
          />
        ))}
      </Stack>
    </Paper>
  );
}

interface PaperRowItemProps {
  paper: PaperRow;
  onUpload?(file: File): void;
  onAddSupplement?(file: File): void;
  onDeleteSupplement?(filename: string): void;
}

function PaperRowItem({
  paper,
  onUpload,
  onAddSupplement,
  onDeleteSupplement,
}: PaperRowItemProps) {
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const supplementInputRef = useRef<HTMLInputElement>(null);
  const title = paper.title ?? "Unknown title";

  return (
    <Stack gap={4} data-testid={`paper-row-${paper.encodedDoi}`}>
      <Group justify="space-between" gap="xs">
        <div className="min-w-0 flex-1">
          <Text size="sm" lineClamp={2}>
            {title}
          </Text>
          {paper.authors && (
            <Text size="xs" c="dimmed">
              {paper.authors}
            </Text>
          )}
        </div>
        <Group gap={4}>
          <ActionIcon
            component="a"
            href={paper.url}
            target="_blank"
            rel="noreferrer"
            variant="subtle"
            aria-label="Open paper URL"
          >
            <IconExternalLink size={14} />
          </ActionIcon>
          {onUpload && (
            <>
              <input
                ref={pdfInputRef}
                type="file"
                accept="application/pdf"
                style={{ display: "none" }}
                data-testid={`paper-upload-input-${paper.encodedDoi}`}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) onUpload(file);
                  e.target.value = "";
                }}
              />
              <Button
                size="xs"
                variant="default"
                leftSection={<IconUpload size={12} />}
                onClick={() => pdfInputRef.current?.click()}
              >
                Upload PDF
              </Button>
            </>
          )}
          {onAddSupplement && (
            <>
              <input
                ref={supplementInputRef}
                type="file"
                accept=".xlsx,.xls,.docx,.pdf"
                style={{ display: "none" }}
                data-testid={`paper-supplement-input-${paper.encodedDoi}`}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) onAddSupplement(file);
                  e.target.value = "";
                }}
              />
              <Button
                size="xs"
                variant="default"
                leftSection={<IconPaperclip size={12} />}
                onClick={() => supplementInputRef.current?.click()}
              >
                Add supplement
              </Button>
            </>
          )}
        </Group>
      </Group>
      {onAddSupplement && paper.supplements.length > 0 && (
        <Group gap={4} pl={4}>
          {paper.supplements.map((name) => (
            <Badge
              key={name}
              variant="light"
              color="grape"
              tt="none"
              rightSection={
                onDeleteSupplement ? (
                  <ActionIcon
                    size="xs"
                    variant="transparent"
                    color="grape"
                    aria-label={`Remove supplement ${prettifySupplementName(name)}`}
                    onClick={() => onDeleteSupplement(name)}
                  >
                    <IconX size={10} />
                  </ActionIcon>
                ) : undefined
              }
            >
              {prettifySupplementName(name)}
            </Badge>
          ))}
        </Group>
      )}
    </Stack>
  );
}
