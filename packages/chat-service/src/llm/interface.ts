import type { JSONValue, LanguageModel, ModelMessage } from "ai";

/**
 * Chat-service's view of an LLM provider. Wraps a Vercel AI SDK
 * `LanguageModel` with two optional knobs:
 *
 * - `providerOptions`: per-provider thinking/reasoning configuration that
 *   chat-service merges into every `streamText` / `generateText` call.
 * - `prepareStep`: per-step messages transformation. Used by the bedrock
 *   provider to inject a `cachePoint` on the last message for prompt
 *   caching; other providers omit it. chat-service calls this on every
 *   tool-loop step if defined.
 */
export interface LlmProvider {
  /**
   * Provider name following OpenTelemetry GenAI semantic conventions:
   * `aws.bedrock`, `anthropic`, `gcp.gemini`, `openai`. Used to label
   * telemetry attributes.
   */
  readonly name: string;

  /** The configured Vercel AI SDK `LanguageModel`. */
  readonly model: LanguageModel;

  /**
   * Provider-specific options merged into `streamText` / `generateText`
   * calls. Shape is provider-specific (see each provider module);
   * matches the AI SDK's `SharedV3ProviderOptions` shape (a record keyed
   * by provider name, with each value a JSON object of provider-specific
   * fields).
   */
  readonly providerOptions: Record<string, Record<string, JSONValue>>;

  /**
   * Optional per-step messages transformation. The bedrock and anthropic
   * providers use this to inject a cache marker on the last message for
   * prompt caching; google and openai omit it.
   *
   * Receives the full step options from the AI SDK (only `messages` is
   * surfaced; the rest of the options pass through). Return a new
   * `messages` array with provider-specific markers applied.
   */
  readonly prepareStep?: (options: { messages: ModelMessage[] }) => {
    messages: ModelMessage[];
  };
}
