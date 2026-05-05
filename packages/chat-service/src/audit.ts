/** Audit logging — per-session JSON files written to storage. */

import type { UIMessage } from "ai";
import type { Storage } from "./storage/interface.js";
import { auditLogKey } from "./storage-keys.js";

interface StepRecord {
  finishReason: string;
  text: string;
  toolCalls: unknown[];
  toolResults: unknown[];
}

interface TurnRecord {
  timestamp: string;
  request: {
    messages: UIMessage[];
  };
  steps?: StepRecord[];
  response?: {
    text: string;
    toolCalls: unknown;
    usage: unknown;
  };
  truncated?: boolean;
  error?: string;
}

interface SessionAuditLog {
  sessionId: string;
  userId: string;
  variantId: string;
  turns: TurnRecord[];
}

/** In-memory accumulator per session, flushed to storage after each turn completes. */
const logs = new Map<string, SessionAuditLog>();

function getOrCreateLog(
  sessionId: string,
  userId: string,
  variantId: string,
): SessionAuditLog {
  let log = logs.get(sessionId);
  if (!log) {
    log = { sessionId, userId, variantId, turns: [] };
    logs.set(sessionId, log);
  }
  return log;
}

export async function logRequest(params: {
  sessionId: string;
  userId: string;
  variantId: string;
  messages: UIMessage[];
}): Promise<void> {
  const log = getOrCreateLog(params.sessionId, params.userId, params.variantId);
  log.turns.push({
    timestamp: new Date().toISOString(),
    request: { messages: params.messages },
    steps: [],
  });
}

export async function logStep(params: {
  sessionId: string;
  finishReason: string;
  text: string;
  toolCalls: unknown[];
  toolResults: unknown[];
}): Promise<void> {
  const log = logs.get(params.sessionId);
  if (!log) return;
  const lastTurn = log.turns.at(-1);
  if (lastTurn) {
    lastTurn.steps ??= [];
    lastTurn.steps.push({
      finishReason: params.finishReason,
      text: params.text,
      toolCalls: params.toolCalls,
      toolResults: params.toolResults,
    });
  }
}

export function markTurnTruncated(sessionId: string): void {
  const log = logs.get(sessionId);
  if (!log) return;
  const lastTurn = log.turns.at(-1);
  if (lastTurn) {
    lastTurn.truncated = true;
  }
}

export async function logResponse(
  storage: Storage,
  params: {
    sessionId: string;
    userId: string;
    response: string;
    toolCalls: unknown;
    usage: unknown;
  },
): Promise<void> {
  const log = logs.get(params.sessionId);
  if (!log) return;
  const lastTurn = log.turns.at(-1);
  if (lastTurn) {
    lastTurn.response = {
      text: params.response,
      toolCalls: params.toolCalls,
      usage: params.usage,
    };
  }
  await storage.writeJson(auditLogKey(log.variantId, log.sessionId), log);
}

export async function logError(
  storage: Storage,
  sessionId: string,
  error: string,
): Promise<void> {
  const log = logs.get(sessionId);
  if (!log) return;
  const lastTurn = log.turns.at(-1);
  if (lastTurn) {
    lastTurn.error = error;
  }
  await storage.writeJson(auditLogKey(log.variantId, log.sessionId), log);
}

/** For tests: clear the per-session audit log map. */
export function clearAuditLogs(): void {
  logs.clear();
}
