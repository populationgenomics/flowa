import type { UIMessage } from "ai";
import { isToolUIPart } from "ai";
import { LlmContent } from "../llm-content/LlmContent";
import type { PaperIdMapping } from "../citations/types";
import { ReasoningStep } from "./ReasoningStep";
import { ToolStep } from "./ToolStep";

/**
 * Renders the parts of a single chat message as an activity trace: the visible
 * answer (text) plus collapsible reasoning and tool-call rows. The rich data
 * (tool names, state, input/output, reasoning text) already arrives in the
 * stream — this surfaces it instead of collapsing every part to "Working…".
 *
 * Keying: tool rows key by `toolCallId` so each row's local open state stays
 * attached to the right call as the part mutates through its states while
 * streaming; text/reasoning rows key by position (they are append-only).
 */
export function MessageParts({
  message,
  paperIdMapping,
}: {
  message: UIMessage;
  paperIdMapping: PaperIdMapping;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      {message.parts.map((part, i) => {
        if (part.type === "text") {
          return (
            <div key={`text-${i}`} className="flowa-llm-content">
              <LlmContent
                markdown={part.text}
                paperIdMapping={paperIdMapping}
              />
            </div>
          );
        }
        if (part.type === "reasoning") {
          return <ReasoningStep key={`reasoning-${i}`} part={part} />;
        }
        if (isToolUIPart(part)) {
          return <ToolStep key={`tool-${part.toolCallId}`} part={part} />;
        }
        return null;
      })}
    </div>
  );
}
