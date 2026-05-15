import { Badge, Stack, Text } from "@mantine/core";
import type { ProgressEvent } from "@/lib/progressEvents";

interface ProgressLogProps {
  events: ProgressEvent[];
  emptyMessage?: string;
}

function eventLabel(ev: ProgressEvent): string {
  if (ev.kind === "paper") {
    const counter =
      typeof ev.done === "number" && typeof ev.total === "number"
        ? ` (${ev.done}/${ev.total})`
        : "";
    const detail = ev.detail ? ` — ${ev.detail}` : "";
    return `${ev.stage}: ${ev.paper_id ?? "?"}${counter}${detail}`;
  }
  if (ev.kind === "stage_started") return `${ev.stage}: started`;
  if (ev.kind === "stage_done") {
    const counter =
      typeof ev.done === "number" && typeof ev.total === "number"
        ? ` (${ev.done}/${ev.total})`
        : "";
    return `${ev.stage}: done${counter}`;
  }
  if (ev.kind === "run_done")
    return `run: done${ev.detail ? ` — ${ev.detail}` : ""}`;
  return `run: error${ev.error ? ` — ${ev.error}` : ""}`;
}

function eventColor(ev: ProgressEvent): string {
  if (ev.kind === "run_error") return "red";
  if (ev.kind === "run_done") return "green";
  if (ev.kind === "stage_done") return "blue";
  if (ev.kind === "paper" && ev.detail === "failed") return "red";
  return "gray";
}

export function ProgressLog({ events, emptyMessage }: ProgressLogProps) {
  if (events.length === 0) {
    return (
      <Text size="sm" c="dimmed" data-testid="progress-log-empty">
        {emptyMessage ?? "No progress events yet."}
      </Text>
    );
  }
  return (
    <Stack gap={4} data-testid="progress-log">
      {events.map((ev, i) => (
        <div
          key={`${ev.timestamp}-${i}`}
          data-testid={`progress-event-${ev.kind}`}
          className="flex items-baseline gap-2"
        >
          <Badge size="sm" color={eventColor(ev)} variant="light">
            {ev.kind}
          </Badge>
          <Text size="xs" c="dimmed" component="span">
            {ev.timestamp}
          </Text>
          <Text size="sm" component="span">
            {eventLabel(ev)}
          </Text>
        </div>
      ))}
    </Stack>
  );
}
