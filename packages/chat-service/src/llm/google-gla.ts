import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LlmProvider } from "./interface.js";

export interface GoogleGlaProviderOptions {
  modelId: string;
  /** Optional pre-built provider client. */
  client?: ReturnType<typeof createGoogleGenerativeAI>;
}

/**
 * Google Generative Language API (`google-gla`) — Gemini via the public
 * key-based API (`GOOGLE_API_KEY`). For Vertex AI, use `./google-vertex`.
 *
 * `providerOptions.google.thinkingConfig.includeThoughts = true` surfaces
 * Gemini's reasoning trace.
 *
 * No `prepareStep` here: Google's prompt caching is via separate
 * `CachedContent` API references rather than per-message markers, so it
 * doesn't fit the per-step injection shape that `prepareStep` provides.
 * Implicit caching for prompts above ~32K tokens (Gemini 2.5+) still
 * applies automatically.
 */
export function createGoogleGlaProvider(
  options: GoogleGlaProviderOptions,
): LlmProvider {
  const client = options.client ?? createGoogleGenerativeAI();
  return {
    name: "gcp.gemini",
    model: client(options.modelId),
    providerOptions: {
      google: {
        thinkingConfig: {
          includeThoughts: true,
        },
      },
    },
  };
}
