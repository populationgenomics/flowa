import { useId, useState } from "react";
import { Code, Collapse, Loader, Text, ThemeIcon } from "@mantine/core";
import {
  IconAlertTriangle,
  IconBolt,
  IconChevronRight,
  IconCircleCheck,
  IconCircleX,
  IconTool,
} from "@tabler/icons-react";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  formatPayload,
  summarize,
  toolDisplayName,
  toolStatus,
} from "./trace-format";

type ToolPart = DynamicToolUIPart | ToolUIPart;

function StatusIcon({ state }: { state: string }) {
  const { kind, color } = toolStatus(state);
  if (kind === "spinner") {
    return <Loader size={12} data-testid="tool-spinner" />;
  }
  const Icon =
    kind === "success"
      ? IconCircleCheck
      : kind === "error"
        ? IconAlertTriangle
        : kind === "denied"
          ? IconCircleX
          : kind === "pending"
            ? IconBolt
            : IconTool;
  return (
    <ThemeIcon
      variant="light"
      color={color}
      size={18}
      radius="xl"
      aria-label={state}
      data-testid="tool-status"
      data-state={state}
      style={{ flexShrink: 0 }}
    >
      <Icon size={12} />
    </ThemeIcon>
  );
}

function PayloadBlock({
  label,
  value,
  testid,
}: {
  label: string;
  value: unknown;
  testid: string;
}) {
  return (
    <div className="mb-1">
      <div className="text-[10px] font-semibold uppercase text-gray-400">
        {label}
      </div>
      <Code
        block
        data-testid={testid}
        className="max-h-40 overflow-auto whitespace-pre-wrap text-[11px]"
      >
        {formatPayload(value)}
      </Code>
    </div>
  );
}

/**
 * One collapsible row in the assistant's activity trace, representing a single
 * tool call. The header shows a live status icon, the raw tool name, and a
 * generic one-line input hint; below it a one-line output (or error) summary is
 * always visible once the call completes. Expanding reveals the full raw input
 * and output.
 */
export function ToolStep({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const inputSummary = summarize(part.input);

  return (
    <div className="my-0.5" data-testid="tool-step" data-state={part.state}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-gray-100"
        data-testid="tool-step-header"
      >
        <IconChevronRight
          size={12}
          aria-hidden
          style={{
            color: "var(--mantine-color-gray-5)",
            flexShrink: 0,
            transform: open ? "rotate(90deg)" : "none",
            transition: "transform 120ms",
          }}
        />
        <StatusIcon state={part.state} />
        <Code className="text-[11px]">{toolDisplayName(part)}</Code>
        {inputSummary && (
          <Text size="xs" c="dimmed" truncate className="min-w-0 flex-1">
            {inputSummary}
          </Text>
        )}
      </button>
      {/* One-line output/error summary, always visible once complete (until the
          row is expanded to its full payload). */}
      {!open && part.state === "output-available" && (
        <div
          data-testid="tool-output-summary"
          className="truncate pl-[42px] pr-1 text-xs text-gray-500"
        >
          {summarize(part.output)}
        </div>
      )}
      {!open && part.state === "output-error" && (
        <div
          data-testid="tool-output-summary"
          className="truncate pl-[42px] pr-1 text-xs text-red-600"
        >
          {summarize(part.errorText)}
        </div>
      )}
      <Collapse in={open}>
        <div id={panelId} role="region" className="px-2 py-1">
          <PayloadBlock
            label="input"
            value={part.input}
            testid="payload-input"
          />
          {part.state === "output-available" && (
            <PayloadBlock
              label="output"
              value={part.output}
              testid="payload-output"
            />
          )}
          {part.state === "output-error" && (
            <Code
              block
              data-testid="payload-error"
              className="whitespace-pre-wrap text-[11px] text-red-700"
            >
              {part.errorText}
            </Code>
          )}
        </div>
      </Collapse>
    </div>
  );
}
