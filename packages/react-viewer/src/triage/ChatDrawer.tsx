import { useCallback, useEffect, useRef, type KeyboardEvent } from "react";
import { Alert, Button, Loader, Text, Textarea } from "@mantine/core";
import { IconAlertCircle, IconSend, IconX } from "@tabler/icons-react";
import type { UIMessage } from "ai";
import { LlmContent } from "../llm-content/LlmContent";
import type { PaperIdMapping } from "../citations/types";

export interface TriageStatePayload {
  version_id: string;
  accepted: { paper_id: string; claim_index: number }[];
  rejected: { paper_id: string; claim_index: number }[];
  papers_done: string[];
  comments: { paper_id: string; claim_index: number; body: string }[];
}

export interface ChatDrawerProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  messages: UIMessage[];
  /** useChat status — "streaming" | "submitted" indicates in-flight. */
  status: "ready" | "streaming" | "submitted" | "error";
  error: Error | undefined;
  input: string;
  onInputChange: (text: string) => void;
  onSend: () => void;
  /** Ref to the textarea so the parent can imperatively focus it. */
  inputRef?: React.Ref<HTMLTextAreaElement>;
  paperIdMapping: PaperIdMapping;
  /**
   * Visually and functionally disables the input. Parent sets this during
   * rewrite or before a chat session is ready.
   */
  disabled?: boolean;
  /**
   * Optional placeholder to show in place of the message list before the
   * parent has created a session.
   */
  pendingSessionLabel?: string;
}

/**
 * Presentational chat drawer. All state (messages, input, open, session) is
 * owned by the parent. This component just renders.
 */
export function ChatDrawer({
  isOpen,
  onOpenChange,
  messages,
  status,
  error,
  input,
  onInputChange,
  onSend,
  inputRef,
  paperIdMapping,
  disabled,
  pendingSessionLabel,
}: ChatDrawerProps) {
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const isStreaming = status === "streaming" || status === "submitted";
  const sendLocked = isStreaming || disabled === true;

  const handleSend = useCallback(() => {
    if (!input.trim() || sendLocked) return;
    onSend();
  }, [input, sendLocked, onSend]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  useEffect(() => {
    const el = messagesContainerRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages]);

  return (
    <div
      className="flex shrink-0 flex-col border-t border-gray-200 bg-white"
      data-testid="chat-drawer"
      data-open={isOpen ? "true" : "false"}
    >
      {isOpen && (
        <div
          className="flex flex-col"
          style={{ maxHeight: "40vh", minHeight: "180px" }}
        >
          <div className="flex items-center justify-between border-b border-gray-100 px-3 py-1">
            <Text size="xs" fw={600} c="dimmed">
              Chat
            </Text>
            <Button
              size="compact-xs"
              variant="subtle"
              onClick={() => onOpenChange(false)}
              leftSection={<IconX size={12} />}
              data-testid="chat-drawer-close"
            >
              close
            </Button>
          </div>
          <div
            ref={messagesContainerRef}
            className="min-h-0 flex-1 overflow-y-auto p-2"
          >
            {pendingSessionLabel ? (
              <div className="flex h-full items-center justify-center gap-2">
                <Loader size="xs" />
                <Text size="xs" c="dimmed">
                  {pendingSessionLabel}
                </Text>
              </div>
            ) : messages.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <Text size="xs" c="dimmed">
                  Ask about a claim, or instruct the assistant.
                </Text>
              </div>
            ) : (
              messages.map((message) => (
                <div
                  key={message.id}
                  className={`mb-2 ${message.role === "user" ? "ml-6" : "mr-6"}`}
                >
                  <Text size="xs" c="dimmed" fw={500} className="mb-1">
                    {message.role === "user" ? "You" : "Assistant"}
                  </Text>
                  <div
                    className={`rounded-lg px-2 py-1 text-sm ${
                      message.role === "user" ? "bg-blue-50" : "bg-gray-50"
                    }`}
                  >
                    {message.parts.map((part, i) => {
                      if (part.type === "text") {
                        return (
                          <div key={i} className="flowa-llm-content">
                            <LlmContent
                              markdown={part.text}
                              paperIdMapping={paperIdMapping}
                            />
                          </div>
                        );
                      }
                      if (part.type === "reasoning") {
                        return (
                          <div
                            key={i}
                            className="my-1 text-xs italic text-gray-400"
                          >
                            Thinking…
                          </div>
                        );
                      }
                      if (
                        part.type === "dynamic-tool" ||
                        part.type.startsWith("tool-")
                      ) {
                        return (
                          <div
                            key={i}
                            className="my-1 text-xs italic text-gray-500"
                          >
                            Working…
                          </div>
                        );
                      }
                      return null;
                    })}
                  </div>
                </div>
              ))
            )}
            {isStreaming && messages.at(-1)?.role !== "assistant" && (
              <div className="mb-2 mr-6">
                <Loader size="xs" className="ml-2" />
              </div>
            )}
          </div>
          {error && (
            <Alert
              icon={<IconAlertCircle size={16} />}
              color="red"
              className="mx-2 mb-1"
            >
              {error.message}
            </Alert>
          )}
        </div>
      )}
      <div className="flex items-center gap-2 border-t border-gray-100 p-2">
        <Textarea
          ref={inputRef}
          value={input}
          onChange={(e) => onInputChange(e.currentTarget.value)}
          onFocus={() => onOpenChange(true)}
          onKeyDown={handleKeyDown}
          placeholder={
            isOpen
              ? "Type an instruction — Enter to send…"
              : "💬 Ask or instruct…"
          }
          autosize
          minRows={1}
          maxRows={4}
          className="flex-1"
          disabled={disabled}
          data-testid="chat-drawer-input"
        />
        <Button
          onClick={handleSend}
          disabled={!input.trim() || sendLocked}
          size="sm"
          data-testid="chat-drawer-send"
        >
          <IconSend size={14} />
        </Button>
      </div>
    </div>
  );
}
