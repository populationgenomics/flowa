import { useCallback, useEffect, useRef, useState } from "react";
import { ActionIcon, Button, Textarea } from "@mantine/core";
import { IconCheck, IconX } from "@tabler/icons-react";
import type { Claim, TriageStateValue } from "./types";

type CommentStatus = "idle" | "dirty" | "saving" | "saved" | "error";

const COMMENT_DEBOUNCE_MS = 500;

export interface FocusCardProps {
  paperId: string;
  claimIndex: number;
  claim: Claim;
  state: TriageStateValue;
  comment: string;
  paperClaimTotal: number;
  quoteIndex: number;
  onCycleQuote(): void;
  onAccept(): void;
  onReject(): void;
  onAsk(): void;
  onSaveComment(
    paperId: string,
    claimIndex: number,
    body: string,
  ): Promise<void>;
  commentTextareaRef: React.RefObject<HTMLTextAreaElement>;
  /** When true, hide "Ask in chat" (no chat session). Accept/Reject/Note stay. */
  readOnly?: boolean;
  /**
   * Disable Accept/Reject/Note actions (e.g. while triage state is still
   * loading for the current version — acting on the focused claim before the
   * load lands would race with it).
   */
  disabled?: boolean;
}

export function FocusCard({
  paperId,
  claimIndex,
  claim,
  state,
  comment,
  paperClaimTotal,
  quoteIndex,
  onCycleQuote,
  onAccept,
  onReject,
  onAsk,
  onSaveComment,
  commentTextareaRef,
  readOnly,
  disabled = false,
}: FocusCardProps) {
  const [value, setValue] = useState(comment);
  const [status, setStatus] = useState<CommentStatus>(
    comment === "" ? "idle" : "saved",
  );

  const draftOwnerRef = useRef({ paperId, claimIndex, serverBody: comment });
  const debounceRef = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    pending: string | null;
  }>({ timer: null, pending: null });
  const saveSeqRef = useRef(0);

  const save = useCallback(
    async (body: string, forPaperId: string, forClaimIndex: number) => {
      const seq = ++saveSeqRef.current;
      setStatus("saving");
      try {
        await onSaveComment(forPaperId, forClaimIndex, body);
        if (seq !== saveSeqRef.current) return;
        if (
          forPaperId === draftOwnerRef.current.paperId &&
          forClaimIndex === draftOwnerRef.current.claimIndex
        ) {
          draftOwnerRef.current.serverBody = body;
          setStatus(body === "" ? "idle" : "saved");
        }
      } catch {
        if (seq !== saveSeqRef.current) return;
        if (
          forPaperId === draftOwnerRef.current.paperId &&
          forClaimIndex === draftOwnerRef.current.claimIndex
        ) {
          setStatus("error");
        }
      }
    },
    [onSaveComment],
  );

  const flush = useCallback(() => {
    const { timer, pending } = debounceRef.current;
    if (timer != null) {
      clearTimeout(timer);
      debounceRef.current.timer = null;
    }
    if (pending == null) return;
    const {
      paperId: pId,
      claimIndex: cIdx,
      serverBody,
    } = draftOwnerRef.current;
    debounceRef.current.pending = null;
    if (pending === serverBody) return;
    void save(pending, pId, cIdx);
  }, [save]);

  const flushRef = useRef(flush);
  flushRef.current = flush;

  useEffect(() => {
    flushRef.current();
    setValue(comment);
    setStatus(comment === "" ? "idle" : "saved");
    draftOwnerRef.current = { paperId, claimIndex, serverBody: comment };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperId, claimIndex]);

  useEffect(() => {
    return () => {
      flushRef.current();
    };
  }, []);

  const handleChange = (next: string) => {
    setValue(next);
    const trimmed = next.trim();
    const serverBody = draftOwnerRef.current.serverBody;
    if (trimmed === serverBody) {
      if (debounceRef.current.timer) {
        clearTimeout(debounceRef.current.timer);
        debounceRef.current.timer = null;
      }
      debounceRef.current.pending = null;
      setStatus(trimmed === "" ? "idle" : "saved");
      return;
    }
    setStatus("dirty");
    if (debounceRef.current.timer) clearTimeout(debounceRef.current.timer);
    debounceRef.current.pending = trimmed;
    debounceRef.current.timer = setTimeout(() => {
      debounceRef.current.timer = null;
      const body = debounceRef.current.pending ?? "";
      debounceRef.current.pending = null;
      const { paperId: pId, claimIndex: cIdx } = draftOwnerRef.current;
      void save(body, pId, cIdx);
    }, COMMENT_DEBOUNCE_MS);
  };

  const handleBlur = () => flush();

  const retry = () => {
    const trimmed = value.trim();
    const { paperId: pId, claimIndex: cIdx } = draftOwnerRef.current;
    void save(trimmed, pId, cIdx);
  };

  const quotes = claim.citations;
  const activeQuote = quotes[quoteIndex] ?? quotes[0];

  const showStatus =
    status !== "idle" ||
    value.trim() !== "" ||
    draftOwnerRef.current.serverBody !== "";
  const statusLabel: Record<CommentStatus, string> = {
    idle: "",
    dirty: "unsaved",
    saving: "saving…",
    saved: "saved",
    error: "save failed — retry",
  };
  const statusClass: Record<CommentStatus, string> = {
    idle: "",
    dirty: "text-gray-500",
    saving: "text-gray-500",
    saved: "text-gray-500",
    error: "text-red-600 cursor-pointer underline",
  };

  return (
    <div
      className="rounded border-2 border-blue-400 bg-white p-3"
      data-testid="focus-card"
      data-paper-id={paperId}
      data-claim-index={claimIndex}
      data-state={state}
    >
      <div className="text-xs uppercase tracking-wide text-blue-600">
        FOCUS · Claim {claimIndex} of {paperClaimTotal}
      </div>
      <div className="my-2 text-base leading-relaxed">{claim.text}</div>

      {quotes.length > 0 && (
        <div className="mb-2 rounded bg-gray-50 p-2 text-sm">
          {quotes.length > 1 && (
            <div className="mb-1 flex items-center gap-2 text-xs text-gray-500">
              Supporting quotes ({quotes.length})
              <ActionIcon size="xs" variant="subtle" onClick={onCycleQuote}>
                ⇥
              </ActionIcon>
            </div>
          )}
          <div className="line-clamp-3 italic text-gray-800">
            &ldquo;{activeQuote?.quote ?? ""}&rdquo;
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button
          size="xs"
          color="green"
          variant={state === "ACCEPTED" ? "filled" : "light"}
          leftSection={<IconCheck size={14} />}
          onClick={onAccept}
          disabled={disabled}
          data-testid="accept-button"
        >
          Accept (a)
        </Button>
        <Button
          size="xs"
          color="red"
          variant={state === "REJECTED" ? "filled" : "light"}
          leftSection={<IconX size={14} />}
          onClick={onReject}
          disabled={disabled}
          data-testid="reject-button"
        >
          Reject (r)
        </Button>
        {!readOnly && (
          <Button size="xs" variant="subtle" onClick={onAsk}>
            💬 Ask in chat
          </Button>
        )}
      </div>

      <div className="mt-3">
        <div className="mb-1 flex items-baseline justify-between text-xs">
          <span className="font-semibold text-gray-600">Note (c)</span>
          <span
            data-testid="comment-status"
            data-state={status}
            className={statusClass[status]}
            onClick={status === "error" ? retry : undefined}
          >
            {showStatus ? statusLabel[status] : ""}
          </span>
        </div>
        <Textarea
          ref={commentTextareaRef}
          autosize
          minRows={2}
          value={value}
          onChange={(e) => handleChange(e.currentTarget.value)}
          onBlur={handleBlur}
          disabled={disabled}
          placeholder="Why did you accept/reject this claim?"
          data-testid="comment-textarea"
        />
      </div>
    </div>
  );
}
