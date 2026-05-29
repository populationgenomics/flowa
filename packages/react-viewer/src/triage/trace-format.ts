/**
 * Pure, framework-free helpers for the chat activity trace (ToolStep /
 * ReasoningStep). Kept DOM-free so the formatting and truncation logic is
 * unit-testable without React or a DOM.
 */

const SUMMARY_CAP = 80;
const PAYLOAD_CAP = 2000;

export type ToolStatusKind =
  | "spinner"
  | "success"
  | "error"
  | "denied"
  | "pending"
  | "neutral";

/**
 * Map a tool part's `state` to a presentational status. Covers the full
 * DynamicToolUIPart / ToolUIPart state union; the `default` arm keeps any
 * future SDK state rendering a neutral icon rather than a blank row.
 */
export function toolStatus(state: string): {
  kind: ToolStatusKind;
  color: string;
} {
  switch (state) {
    case "input-streaming":
    case "input-available":
    case "approval-responded":
      return { kind: "spinner", color: "gray" };
    case "approval-requested":
      return { kind: "pending", color: "yellow" };
    case "output-available":
      return { kind: "success", color: "green" };
    case "output-error":
      return { kind: "error", color: "red" };
    case "output-denied":
      return { kind: "denied", color: "gray" };
    default:
      return { kind: "neutral", color: "gray" };
  }
}

/**
 * Display name for a tool part: the raw tool name, never a friendly alias. For
 * dynamic tools the name is on the part; for typed `tool-${name}` parts it is
 * encoded in the type.
 */
export function toolDisplayName(part: {
  type: string;
  toolName?: string;
}): string {
  if (part.toolName) return part.toolName;
  if (part.type.startsWith("tool-")) return part.type.slice("tool-".length);
  return part.type;
}

export function truncate(s: string, cap: number): string {
  return s.length <= cap ? s : `${s.slice(0, cap)}…`;
}

function firstLine(s: string): string {
  const newline = s.indexOf("\n");
  return newline === -1 ? s : s.slice(0, newline);
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * A terse one-line summary of a tool input or output, derived generically with
 * no per-tool knowledge. For objects it prefers the first scalar field
 * (`pattern: …`, `insert_line: …`) and otherwise lists keys with array counts
 * (`paperIds (3)`); for a multi-line string output it shows the first line.
 * Tolerates the partial / `undefined` value present while a call is streaming.
 */
export function summarize(value: unknown, cap = SUMMARY_CAP): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return truncate(firstLine(value), cap);
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value))
    return truncate(collapseWhitespace(JSON.stringify(value)), cap);
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key, v] of entries) {
      const t = typeof v;
      if (t === "string" || t === "number" || t === "boolean") {
        return truncate(`${key}: ${collapseWhitespace(String(v))}`, cap);
      }
    }
    if (entries.length === 0) return "";
    return truncate(
      entries
        .map(([key, v]) => (Array.isArray(v) ? `${key} (${v.length})` : key))
        .join(", "),
      cap,
    );
  }
  return truncate(collapseWhitespace(String(value)), cap);
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return String(value);
  if (typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      // Circular refs, BigInt, etc. — fall back to a best-effort string.
      return String(value);
    }
  }
  return String(value);
}

/**
 * Format a tool input/output for the expandable body, hard-capped in length so
 * a large edit payload (e.g. a full `artifact_yaml`) cannot blow out the
 * drawer. We intentionally do not diff edits here — the authoritative "what
 * changed" is the artifact version bump surfaced via `artifact_write` metadata.
 */
export function formatPayload(value: unknown, cap = PAYLOAD_CAP): string {
  const s = stringifyValue(value);
  if (s.length <= cap) return s;
  return `${s.slice(0, cap)}…\n(truncated, ${s.length} chars total)`;
}
