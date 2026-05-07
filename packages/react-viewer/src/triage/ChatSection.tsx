import { useCallback, useEffect, useMemo, useRef } from "react";
import type { UIMessage } from "ai";
import { DefaultChatTransport } from "ai";
import { useChat } from "@ai-sdk/react";
import type { PaperIdMapping } from "../citations/types";
import { ChatDrawer, type TriageStatePayload } from "./ChatDrawer";

/**
 * Metadata attached by chat-service to the finish event of each message.
 * See `messageMetadata` in `@flowajs/chat-service` (src/chat.ts).
 */
interface ArtifactMetadata {
  artifact_write?: { version: number; parent_version: number };
}

type EditUIMessage = UIMessage<ArtifactMetadata>;

export interface SessionInfo {
  sessionId: string;
  token: string;
  chatUrl: string;
}

export interface ChatSectionProps {
  session: SessionInfo;
  paperIdMapping: PaperIdMapping;
  /** Read the current triage-state snapshot at send time. */
  getTriageState: () => TriageStatePayload;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  input: string;
  onInputChange: (text: string) => void;
  /** Set by the parent to fire a scripted send after the chat mounts. */
  pendingPrompt: string | null;
  onPendingPromptCleared: () => void;
  /**
   * Called when a message stream finishes, with any artifact_write metadata
   * the server attached (null if the turn didn't modify the artifact). Parent
   * uses this for both "record the new version" and "clear rewrite spinner"
   * — the spinner needs to stop whether or not a write happened.
   */
  onMessageFinish: (
    write: { version: number; parent_version: number } | null,
  ) => void;
  /** Parent-imposed disable (e.g. rewrite in progress elsewhere). */
  disabled?: boolean;
  inputRef?: React.Ref<HTMLTextAreaElement>;
}

/**
 * Owns useChat for a given edit session. Renders `ChatDrawer` presentationally.
 * Exists as a separate component so useChat is mounted only after the parent
 * has lazily created a session (useChat's transport depends on the sessionId,
 * which doesn't exist until the curator acts).
 */
export function ChatSection({
  session,
  paperIdMapping,
  getTriageState,
  isOpen,
  onOpenChange,
  input,
  onInputChange,
  pendingPrompt,
  onPendingPromptCleared,
  onMessageFinish,
  disabled,
  inputRef,
}: ChatSectionProps) {
  // Hold the triage-state getter in a ref so the transport's request shaper
  // always reads the latest store snapshot without rebuilding the transport.
  const getTriageStateRef = useRef(getTriageState);
  useEffect(() => {
    getTriageStateRef.current = getTriageState;
  }, [getTriageState]);

  const onMessageFinishRef = useRef(onMessageFinish);
  useEffect(() => {
    onMessageFinishRef.current = onMessageFinish;
  }, [onMessageFinish]);

  const transport = useMemo(
    () =>
      new DefaultChatTransport<EditUIMessage>({
        api: `${session.chatUrl}/chat/${session.sessionId}`,
        headers: { Authorization: `Bearer ${session.token}` },
        prepareSendMessagesRequest: ({ messages, body }) => ({
          body: {
            ...(body ?? {}),
            messages,
            triage_state: getTriageStateRef.current(),
          },
        }),
      }),
    [session.chatUrl, session.sessionId, session.token],
  );

  const { messages, sendMessage, status, error } = useChat<EditUIMessage>({
    id: session.sessionId,
    transport,
    onFinish: ({ message }) => {
      onMessageFinishRef.current(message.metadata?.artifact_write ?? null);
    },
    // If the stream terminates with a chat-service-side error (e.g. storage
    // write failure propagated via controller.error), onFinish never fires.
    // Clear the parent's post-finish state (Rewrite spinner, etc.) explicitly
    // so the UI doesn't get stuck. The error itself is surfaced via `error`
    // below and rendered in the drawer's Alert.
    onError: (err) => {
      console.error("[chat] stream error", err);
      onMessageFinishRef.current(null);
    },
  });

  // Fire any pending scripted prompt as soon as this section is mounted
  // (i.e. once the lazy session has been created). Guarded by a ref so
  // React StrictMode's double-invoked useEffect (dev) doesn't send the
  // prompt twice.
  const lastConsumedPrompt = useRef<string | null>(null);
  useEffect(() => {
    if (pendingPrompt === null) return;
    if (lastConsumedPrompt.current === pendingPrompt) return;
    lastConsumedPrompt.current = pendingPrompt;
    onPendingPromptCleared();
    void sendMessage({ text: pendingPrompt });
  }, [pendingPrompt, onPendingPromptCleared, sendMessage]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    onInputChange("");
    void sendMessage({ text });
  }, [input, onInputChange, sendMessage]);

  return (
    <ChatDrawer
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      messages={messages}
      status={status}
      error={error}
      input={input}
      onInputChange={onInputChange}
      onSend={handleSend}
      inputRef={inputRef}
      paperIdMapping={paperIdMapping}
      disabled={disabled}
    />
  );
}
