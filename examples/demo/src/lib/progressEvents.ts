/**
 * Wire shape of one event from `progress.jsonl`. Mirrors
 * `flowa.progress.ProgressEvent` (a frozen dataclass on the Python
 * side). Imported by both the `GET /api/runs/[variantId]/[runId]/progress`
 * route handler and the literature page that renders the events.
 */

export interface ProgressEvent {
  timestamp: string;
  stage: "query" | "download" | "convert" | "extract" | "aggregate";
  kind: "stage_started" | "paper" | "stage_done" | "run_done" | "run_error";
  paper_id?: string | null;
  done?: number | null;
  total?: number | null;
  detail?: string | null;
  error?: string | null;
}

export interface ProgressResponse {
  events: ProgressEvent[];
  terminal: boolean;
}
