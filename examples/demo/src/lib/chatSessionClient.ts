/**
 * Browser-side helper that mints a chat-service session for a given
 * artifact version. Used by `<EvidenceViewerShell>` via the
 * `chatSessionFactory` prop.
 */

import type { SessionInfo } from "@flowajs/react-viewer";

export interface ChatSessionConfig {
  /** Base URL for chat-service; e.g. "http://localhost:7701". */
  chatBase: string;
  /** Demo's surrogate user identity. */
  userId: string;
}

export interface CreateChatSessionInput {
  variantId: string;
  category: string;
  /** Pipeline output is v0; edit drafts start at v1. */
  version: number;
  /** Raw artifact JSON text the session should bind to. */
  artifactText: string;
}

export async function createChatSession(
  config: ChatSessionConfig,
  input: CreateChatSessionInput,
): Promise<SessionInfo> {
  const res = await fetch(`${config.chatBase}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      variant_id: input.variantId,
      user_id: config.userId,
      category: input.category,
      initial_artifact: input.artifactText,
      initial_version: input.version,
    }),
  });
  if (!res.ok) {
    throw new Error(`POST ${config.chatBase}/sessions → ${res.status}`);
  }
  const data = (await res.json()) as {
    session_id: string;
    token: string;
  };
  return {
    sessionId: data.session_id,
    token: data.token,
    chatUrl: config.chatBase,
  };
}
