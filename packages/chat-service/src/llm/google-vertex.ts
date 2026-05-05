import { createVertex } from "@ai-sdk/google-vertex";
import type { LlmProvider } from "./interface.js";

export interface GoogleVertexProviderOptions {
  modelId: string;
  /** Optional pre-built provider client. */
  client?: ReturnType<typeof createVertex>;
}

/**
 * Google Vertex AI provider — Gemini via Vertex (GCP service-account
 * auth). For the public key-based API, use `./google-gla`.
 *
 * Verified against `@ai-sdk/google-vertex` v4
 * (https://ai-sdk.dev/providers/ai-sdk-providers/google-vertex):
 * the namespace key is `vertex` (not `google`); the `thinkingConfig`
 * shape matches.
 *
 * No `prepareStep`: same reasoning as `./google-gla` — Vertex's explicit
 * caching is via `CachedContent` references, not per-message markers.
 */
export function createGoogleVertexProvider(
  options: GoogleVertexProviderOptions,
): LlmProvider {
  const client = options.client ?? createVertex();
  return {
    name: "gcp.gemini",
    model: client(options.modelId),
    providerOptions: {
      vertex: {
        thinkingConfig: {
          includeThoughts: true,
        },
      },
    },
  };
}
