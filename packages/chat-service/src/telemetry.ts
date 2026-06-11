/**
 * Telemetry helpers. Pure — no side effects at module load.
 * The SDK is bootstrapped in instrumentation.ts (loaded via --import);
 * if it hasn't run, metrics.getMeter() returns a no-op meter.
 */

import { metrics } from "@opentelemetry/api";

const meter = metrics.getMeter("chat-service");

// ---------------------------------------------------------------------------
// Token usage histogram
// https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-metrics/
// ---------------------------------------------------------------------------

const tokenHistogram = meter.createHistogram("gen_ai.client.token.usage", {
  description: "Number of input and output tokens used",
  unit: "{token}",
  advice: {
    explicitBucketBoundaries: [
      1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304,
      16777216, 67108864,
    ],
  },
});

export function recordTokenUsage({
  model,
  tokenType,
  count,
}: {
  model: string;
  tokenType: "input" | "output";
  count: number;
}): void {
  tokenHistogram.record(count, {
    "gen_ai.token.type": tokenType,
    "gen_ai.response.model": model,
  });
}

// ---------------------------------------------------------------------------
// Tool-execution duration histogram
// Reuses the shared operation-duration histogram with
// gen_ai.operation.name="execute_tool" per OTel GenAI semconv.
// ---------------------------------------------------------------------------

const operationDurationHistogram = meter.createHistogram(
  "gen_ai.client.operation.duration",
  {
    description: "GenAI operation duration.",
    unit: "s",
    advice: {
      explicitBucketBoundaries: [
        0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24,
        20.48, 40.96, 81.92,
      ],
    },
  },
);

export interface ToolMetricsContext {
  /** Provider name (`anthropic`, `aws.bedrock`, `gcp.gemini`, `openai`). */
  providerName: string;
}

// Tools in chat.ts signal curator-visible failures by returning
// `{ error: "..." }` or `{ is_error: true }` rather than throwing.
function isToolErrorResult(result: unknown): boolean {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  const r = result as { error?: unknown; is_error?: unknown };
  return Boolean(r.error) || r.is_error === true;
}

/**
 * Wrap a tool's `execute` with duration instrumentation. The provider name
 * is parameterized so each provider self-labels its own metrics.
 */
export function withToolMetrics<Args, Result>(
  context: ToolMetricsContext,
  name: string,
  execute: (args: Args) => Promise<Result>,
): (args: Args) => Promise<Result> {
  const baseAttrs = {
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.provider.name": context.providerName,
    "gen_ai.tool.name": name,
  };
  return async (args) => {
    const start = performance.now();
    try {
      const result = await execute(args);
      const duration = (performance.now() - start) / 1000;
      operationDurationHistogram.record(
        duration,
        isToolErrorResult(result)
          ? { ...baseAttrs, "error.type": "tool_error" }
          : baseAttrs,
      );
      return result;
    } catch (err) {
      const duration = (performance.now() - start) / 1000;
      operationDurationHistogram.record(duration, {
        ...baseAttrs,
        "error.type": "exception",
      });
      throw err;
    }
  };
}

// ---------------------------------------------------------------------------
// Validation + storage failure counters
// ---------------------------------------------------------------------------

const validationErrorCounter = meter.createCounter(
  "chat_validation_errors_total",
  {
    description:
      "Count of individual rule violations found by validateArtifactContent",
  },
);

export type ValidationRule =
  | "paper_id_duplicate"
  | "paper_id_unknown_in_mapping"
  | "claim_paper_missing"
  | "claims_not_contiguous"
  | "claims_group_order"
  | "cite_unknown_paper_id"
  | "cite_missing_quote"
  | "cite_quote_mismatch"
  | "claim_not_linked_in_writeup";

export function recordValidationError(rule: ValidationRule): void {
  validationErrorCounter.add(1, { rule });
}

const toolValidationFailureCounter = meter.createCounter(
  "chat_tool_validation_failures_total",
  {
    description:
      "Count of tool invocations rejected by validateAndCommit (parse, schema, or content-validation errors)",
  },
);

export function recordToolValidationFailure(
  tool: "str_replace" | "insert" | "write",
): void {
  toolValidationFailureCounter.add(1, { tool });
}

const storageWriteFailureCounter = meter.createCounter(
  "chat_storage_write_failures_total",
  {
    description:
      "Count of writeEditDraft failures that terminated the chat stream with an error",
  },
);

export function recordStorageWriteFailure(): void {
  storageWriteFailureCounter.add(1);
}

// ---------------------------------------------------------------------------
// Cached-input-tokens counter
// ---------------------------------------------------------------------------

const cachedInputTokensCounter = meter.createCounter(
  "gen_ai.client.token.cached_input",
  {
    description: "Input tokens served from / written to provider prompt cache",
    unit: "{token}",
  },
);

export function recordCachedInputTokens({
  model,
  type,
  count,
}: {
  model: string;
  type: "read" | "write";
  count: number;
}): void {
  cachedInputTokensCounter.add(count, {
    "gen_ai.cache.type": type,
    "gen_ai.response.model": model,
  });
}
