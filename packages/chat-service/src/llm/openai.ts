import { createOpenAI } from "@ai-sdk/openai";
import type { LlmProvider } from "./interface.js";

export interface OpenAIProviderOptions {
  modelId: string;
  /** Optional pre-built provider client. */
  client?: ReturnType<typeof createOpenAI>;
}

/**
 * OpenAI provider with reasoning enabled.
 *
 * `providerOptions.openai.reasoningEffort = "medium"` and
 * `reasoningSummary = "detailed"` match the Responses API shape for the
 * GPT-5 series.
 *
 * No `prepareStep`: OpenAI's prompt caching is automatic for prompts
 * above ~1024 tokens — there is no per-message marker to inject.
 */
export function createOpenAIProvider(
  options: OpenAIProviderOptions,
): LlmProvider {
  const client = options.client ?? createOpenAI();
  return {
    name: "openai",
    model: client(options.modelId),
    providerOptions: {
      openai: {
        reasoningEffort: "medium",
        reasoningSummary: "detailed",
      },
    },
  };
}
