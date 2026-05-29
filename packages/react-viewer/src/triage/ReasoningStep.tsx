import { useId, useState } from "react";
import { Collapse, Loader, Text } from "@mantine/core";
import { IconBrain, IconChevronRight } from "@tabler/icons-react";
import type { ReasoningUIPart } from "ai";

/**
 * "Thinking" disclosure for a reasoning part. The reasoning text is shown by
 * default (and streams live while `state === "streaming"`) so the curator can
 * follow along without clicking; the row stays collapsible for long thoughts,
 * and a user click sticks (auto-default stops once `userToggled` is set).
 */
export function ReasoningStep({ part }: { part: ReasoningUIPart }) {
  const streaming = part.state === "streaming";
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const open = userToggled ?? true;
  const panelId = useId();

  return (
    <div
      className="my-0.5"
      data-testid="reasoning-step"
      data-state={part.state ?? ""}
    >
      <button
        type="button"
        onClick={() => setUserToggled(!open)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-gray-100"
        data-testid="reasoning-step-header"
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
        <IconBrain
          size={13}
          aria-hidden
          style={{ color: "var(--mantine-color-gray-5)", flexShrink: 0 }}
        />
        <Text size="xs" c="dimmed" className="italic">
          {streaming ? "Thinking…" : "Thinking"}
        </Text>
        {streaming && <Loader size={10} />}
      </button>
      <Collapse in={open}>
        <div
          id={panelId}
          role="region"
          data-testid="reasoning-text"
          className="max-h-32 overflow-auto whitespace-pre-wrap px-2 py-1 text-xs italic text-gray-400"
        >
          {part.text}
        </div>
      </Collapse>
    </div>
  );
}
