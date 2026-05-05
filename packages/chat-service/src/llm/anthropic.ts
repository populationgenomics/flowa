import { createAnthropic } from "@ai-sdk/anthropic";
import type { ModelMessage } from "ai";
import type { LlmProvider } from "./interface.js";

export interface AnthropicProviderOptions {
  modelId: string;
  /** Optional pre-built provider client. */
  client?: ReturnType<typeof createAnthropic>;
}

/**
 * Anthropic provider with adaptive extended thinking.
 *
 * `providerOptions.anthropic.thinking = { type: "adaptive" }` enables
 * extended thinking for newer models (Sonnet 4.6 / Opus 4.6+) where the
 * model auto-budgets reasoning tokens.
 *
 * `prepareStep` injects `cacheControl: { type: "ephemeral" }` on the last
 * content part of the last message — Anthropic's prompt-caching marker.
 * Same intent as Bedrock's `cachePoint`: cache the prefix (system prompt
 * + history + prior tool results) so subsequent steps and turns read it
 * at lower cost.
 */
export function createAnthropicProvider(
  options: AnthropicProviderOptions,
): LlmProvider {
  const client = options.client ?? createAnthropic();
  return {
    name: "anthropic",
    model: client(options.modelId),
    providerOptions: {
      anthropic: {
        thinking: { type: "adaptive" },
      },
    },
    prepareStep: ({ messages }: { messages: ModelMessage[] }) => ({
      messages: messages.map((msg, i) =>
        i === messages.length - 1
          ? {
              ...msg,
              providerOptions: {
                ...(msg.providerOptions ?? {}),
                anthropic: {
                  cacheControl: { type: "ephemeral" as const },
                },
              },
            }
          : msg,
      ),
    }),
  };
}
