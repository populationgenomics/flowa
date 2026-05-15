import { useRef } from "react";
import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Group,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { IconExternalLink, IconUpload } from "@tabler/icons-react";
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

interface PaperStatusGroupProps {
  status: PaperStatus;
  papers: PaperRow[];
  onUpload?(paper: PaperRow, file: File): void;
}

export function PaperStatusGroup({
  status,
  papers,
  onUpload,
}: PaperStatusGroupProps) {
  if (papers.length === 0) return null;
  return (
    <Paper withBorder p="sm" data-testid={`paper-status-group-${status}`}>
      <Group justify="space-between" mb="xs">
        <Title order={5}>{STATUS_LABELS[status]}</Title>
        <Badge color={STATUS_COLORS[status]} variant="light">
          {papers.length}
        </Badge>
      </Group>
      <Stack gap="xs">
        {papers.map((p) => (
          <PaperRowItem
            key={p.doi}
            paper={p}
            onUpload={onUpload ? (file) => onUpload(p, file) : undefined}
          />
        ))}
      </Stack>
    </Paper>
  );
}

interface PaperRowItemProps {
  paper: PaperRow;
  onUpload?(file: File): void;
}

function PaperRowItem({ paper, onUpload }: PaperRowItemProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const title = paper.title ?? "Unknown title";

  return (
    <Group
      justify="space-between"
      gap="xs"
      data-testid={`paper-row-${paper.encodedDoi}`}
    >
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
              ref={inputRef}
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
              onClick={() => inputRef.current?.click()}
            >
              Upload PDF
            </Button>
          </>
        )}
      </Group>
    </Group>
  );
}
