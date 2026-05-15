import { Badge, Stack, Text } from "@mantine/core";
import type { ProgressEvent } from "@/lib/progressEvents";

interface ProgressLogProps {
  events: ProgressEvent[];
  emptyMessage?: string;
}

// Stage badge keeps the visual column consistent across every row,
// including the per-paper events for download / convert / extract
// (which never emit their own stage_started / stage_done because the
// pipeline interleaves them across papers — the first paper event for
// a stage is implicitly its start).
const STAGE_COLORS: Record<ProgressEvent["stage"], string> = {
  query: "cyan",
  download: "blue",
  convert: "violet",
  extract: "orange",
  aggregate: "teal",
};

function eventLabel(ev: ProgressEvent): string {
  if (ev.kind === "paper") {
    const counter =
      typeof ev.done === "number" && typeof ev.total === "number"
        ? ` (${ev.done}/${ev.total})`
        : "";
    const detail = ev.detail ? ` — ${ev.detail}` : "";
    return `${ev.paper_id ?? "?"}${counter}${detail}`;
  }
  if (ev.kind === "stage_started") return "started";
  if (ev.kind === "stage_done") {
    const counter =
      typeof ev.done === "number" && typeof ev.total === "number"
        ? ` (${ev.done}/${ev.total})`
        : "";
    return `done${counter}`;
  }
  if (ev.kind === "run_done")
    return `complete${ev.detail ? ` — ${ev.detail}` : ""}`;
  return `error${ev.error ? ` — ${ev.error}` : ""}`;
}

function badgeColor(ev: ProgressEvent): string {
  if (ev.kind === "run_error") return "red";
  if (ev.kind === "paper" && ev.detail === "failed") return "red";
  return STAGE_COLORS[ev.stage];
}

function badgeVariant(ev: ProgressEvent): "filled" | "light" {
  // Bracket events (stage_started/stage_done) and run-level outcomes
  // print as filled badges so they stand out as section markers;
  // per-paper events stay light so a long run of them reads as a
  // group rather than a row of saturated chips.
  if (ev.kind === "paper") return "light";
  return "filled";
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
          <Badge
            size="sm"
            color={badgeColor(ev)}
            variant={badgeVariant(ev)}
            w={96}
            ta="center"
          >
            {ev.stage}
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
