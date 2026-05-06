import type { LlmProvider } from "./interface.js";

/**
 * Parse `LLM_MODEL=<provider>:<model>` (matching pydantic-ai's prefix
 * convention; also used by `flowa.settings.ModelConfig.name`) and
 * dispatch to the matching provider module via dynamic import. The
 * underlying `@ai-sdk/<provider>` package is loaded only for the
 * selected provider; missing peers fail with a clear error naming the
 * unresolvable package.
 */
const KNOWN_PROVIDERS = [
  "anthropic",
  "bedrock",
  "google-gla",
  "google-vertex",
  "openai",
] as const;
type KnownProvider = (typeof KNOWN_PROVIDERS)[number];

export async function createProvider(model: string): Promise<LlmProvider> {
  const colon = model.indexOf(":");
  if (colon < 0) {
    throw new Error(
      `Invalid LLM_MODEL: ${JSON.stringify(model)}. Expected "<provider>:<model>", e.g. "bedrock:au.anthropic.claude-sonnet-4-6".`,
    );
  }
  const prefix = model.slice(0, colon);
  const modelId = model.slice(colon + 1);
  if (!modelId) {
    throw new Error(`LLM_MODEL has empty model id after prefix: ${prefix}:`);
  }
  if (!isKnownProvider(prefix)) {
    throw new Error(
      `Unknown LLM provider prefix: ${JSON.stringify(prefix)}. Valid prefixes: ${KNOWN_PROVIDERS.join(", ")}.`,
    );
  }
  switch (prefix) {
    case "anthropic": {
      const { createAnthropicProvider } = await import("./anthropic.js");
      return createAnthropicProvider({ modelId });
    }
    case "bedrock": {
      const { createBedrockProvider } = await import("./bedrock.js");
      const inferenceProfile = process.env.BEDROCK_INFERENCE_PROFILE;
      return createBedrockProvider({
        modelId,
        ...(inferenceProfile ? { inferenceProfile } : {}),
      });
    }
    case "google-gla": {
      const { createGoogleGlaProvider } = await import("./google-gla.js");
      return createGoogleGlaProvider({ modelId });
    }
    case "google-vertex": {
      const { createGoogleVertexProvider } = await import("./google-vertex.js");
      return createGoogleVertexProvider({ modelId });
    }
    case "openai": {
      const { createOpenAIProvider } = await import("./openai.js");
      return createOpenAIProvider({ modelId });
    }
  }
}

function isKnownProvider(s: string): s is KnownProvider {
  return (KNOWN_PROVIDERS as readonly string[]).includes(s);
}
