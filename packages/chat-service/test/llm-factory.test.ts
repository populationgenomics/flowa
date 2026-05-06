import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ModelMessage } from "ai";
import type { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createProvider } from "../src/llm/factory.js";
import { createBedrockProvider } from "../src/llm/bedrock.js";

// Provider construction is lazy in every @ai-sdk/* package — none of them
// touches creds at construction time. We still stub env vars so the SDKs'
// optional discovery paths don't surface warnings.
beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  vi.stubEnv("GOOGLE_API_KEY", "test-key");
  vi.stubEnv("GOOGLE_VERTEX_PROJECT", "test-project");
  vi.stubEnv("GOOGLE_VERTEX_LOCATION", "us-central1");
  vi.stubEnv("AWS_REGION", "us-east-1");
  vi.stubEnv("AWS_ACCESS_KEY_ID", "test-access");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-secret");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Prefix-parse edge cases
// ---------------------------------------------------------------------------

describe("createProvider parsing", () => {
  test("rejects a model string without a colon", async () => {
    await expect(createProvider("just-a-model-name")).rejects.toThrow(
      /Invalid LLM_MODEL/,
    );
  });

  test("rejects an unknown provider prefix", async () => {
    await expect(createProvider("xai:grok-1")).rejects.toThrow(
      /Unknown LLM provider prefix/,
    );
  });

  test("rejects an empty model id", async () => {
    await expect(createProvider("anthropic:")).rejects.toThrow(
      /empty model id/,
    );
  });

  test("preserves colons in the model id beyond the first separator", async () => {
    // bedrock model IDs look like `au.anthropic.claude-sonnet-4-6` (no
    // colons), but if a future provider grows colons in its identifier the
    // factory must split on the FIRST colon only.
    const provider = await createProvider(
      "anthropic:claude-sonnet-4-6:vendored",
    );
    expect(provider.name).toBe("anthropic");
  });
});

// ---------------------------------------------------------------------------
// Per-provider provider-name + providerOptions shapes
// ---------------------------------------------------------------------------

describe("anthropic provider", () => {
  test("name + providerOptions match flowa-Python's adaptive-thinking config", async () => {
    const provider = await createProvider("anthropic:claude-sonnet-4-6");
    expect(provider.name).toBe("anthropic");
    expect(provider.providerOptions).toEqual({
      anthropic: { thinking: { type: "adaptive" } },
    });
  });

  test("prepareStep injects cacheControl: ephemeral on the last message only", async () => {
    const provider = await createProvider("anthropic:claude-sonnet-4-6");
    expect(provider.prepareStep).toBeDefined();
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "user", content: "again" },
    ];
    const out = provider.prepareStep!({ messages });
    expect(out.messages).toHaveLength(2);
    // First message untouched.
    expect(out.messages[0]).toEqual({ role: "user", content: "hi" });
    // Last message gets the cache marker.
    const last = out.messages[1] as ModelMessage & {
      providerOptions?: Record<string, unknown>;
    };
    expect(last.providerOptions?.anthropic).toEqual({
      cacheControl: { type: "ephemeral" },
    });
  });
});

describe("bedrock provider", () => {
  test("name follows OTel GenAI semconv (aws.bedrock); thinking + output_config in providerOptions", async () => {
    const provider = await createProvider(
      "bedrock:au.anthropic.claude-sonnet-4-6",
    );
    expect(provider.name).toBe("aws.bedrock");
    expect(provider.providerOptions).toEqual({
      bedrock: {
        additionalModelRequestFields: {
          thinking: { type: "adaptive" },
          output_config: { effort: "medium" },
        },
      },
    });
  });

  test("prepareStep injects cachePoint on the last message only", async () => {
    const provider = await createProvider(
      "bedrock:au.anthropic.claude-sonnet-4-6",
    );
    expect(provider.prepareStep).toBeDefined();
    const messages: ModelMessage[] = [
      { role: "user", content: "first" },
      { role: "user", content: "second" },
      { role: "user", content: "third" },
    ];
    const out = provider.prepareStep!({ messages });
    expect(out.messages).toHaveLength(3);
    // Earlier messages untouched.
    expect(out.messages[0]).toEqual({ role: "user", content: "first" });
    expect(out.messages[1]).toEqual({ role: "user", content: "second" });
    // Last message carries the cache marker.
    const last = out.messages[2] as ModelMessage & {
      providerOptions?: Record<string, unknown>;
    };
    expect(last.providerOptions?.bedrock).toEqual({
      cachePoint: { type: "default" },
    });
  });

  test("prepareStep merges with existing providerOptions on the last message", async () => {
    const provider = await createProvider(
      "bedrock:au.anthropic.claude-sonnet-4-6",
    );
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: "x",
        providerOptions: { someOther: { keep: true } },
      } as ModelMessage,
    ];
    const out = provider.prepareStep!({ messages });
    const merged = (
      out.messages[0] as ModelMessage & {
        providerOptions: Record<string, unknown>;
      }
    ).providerOptions;
    expect(merged.someOther).toEqual({ keep: true });
    expect(merged.bedrock).toEqual({ cachePoint: { type: "default" } });
  });

  test("without inferenceProfile, modelId is the API target", async () => {
    const calls: string[] = [];
    const fakeClient = ((id: string) => {
      calls.push(id);
      return { id };
    }) as unknown as ReturnType<typeof createAmazonBedrock>;

    await createBedrockProvider({
      modelId: "au.anthropic.claude-sonnet-4-6",
      client: fakeClient,
    });

    expect(calls).toEqual(["au.anthropic.claude-sonnet-4-6"]);
  });

  test("when inferenceProfile is set, ARN is the API target — modelId stays informative", async () => {
    const calls: string[] = [];
    const fakeClient = ((id: string) => {
      calls.push(id);
      return { id };
    }) as unknown as ReturnType<typeof createAmazonBedrock>;

    const arn =
      "arn:aws:bedrock:ap-southeast-2:111111111111:application-inference-profile/abc";
    await createBedrockProvider({
      modelId: "au.anthropic.claude-sonnet-4-6",
      inferenceProfile: arn,
      client: fakeClient,
    });

    expect(calls).toEqual([arn]);
  });

  test("createProvider forwards BEDROCK_INFERENCE_PROFILE env var to the bedrock provider", async () => {
    vi.stubEnv(
      "BEDROCK_INFERENCE_PROFILE",
      "arn:aws:bedrock:us-east-1:111111111111:application-inference-profile/abc",
    );
    const provider = await createProvider(
      "bedrock:au.anthropic.claude-sonnet-4-6",
    );
    // Construction succeeds and the provider name is unchanged. The unit
    // tests above on `createBedrockProvider` cover the API-target swap;
    // here we just verify the env-var read path wires through without
    // surfacing as a runtime error.
    expect(provider.name).toBe("aws.bedrock");
  });
});

describe("google-gla provider", () => {
  test("name + thinkingConfig under the `google` namespace", async () => {
    const provider = await createProvider("google-gla:gemini-2.5-pro");
    expect(provider.name).toBe("gcp.gemini");
    expect(provider.providerOptions).toEqual({
      google: { thinkingConfig: { includeThoughts: true } },
    });
  });

  test("prepareStep is undefined (CachedContent API doesn't fit per-step)", async () => {
    const provider = await createProvider("google-gla:gemini-2.5-pro");
    expect(provider.prepareStep).toBeUndefined();
  });
});

describe("google-vertex provider", () => {
  test("name + thinkingConfig under the `vertex` namespace (separate from google-gla)", async () => {
    const provider = await createProvider("google-vertex:gemini-2.5-pro");
    expect(provider.name).toBe("gcp.gemini");
    expect(provider.providerOptions).toEqual({
      vertex: { thinkingConfig: { includeThoughts: true } },
    });
  });

  test("prepareStep is undefined", async () => {
    const provider = await createProvider("google-vertex:gemini-2.5-pro");
    expect(provider.prepareStep).toBeUndefined();
  });
});

describe("openai provider", () => {
  test("name + reasoning options for the Responses API", async () => {
    const provider = await createProvider("openai:gpt-5");
    expect(provider.name).toBe("openai");
    expect(provider.providerOptions).toEqual({
      openai: {
        reasoningEffort: "medium",
        reasoningSummary: "detailed",
      },
    });
  });

  test("prepareStep is undefined (caching is automatic above ~1024 tokens)", async () => {
    const provider = await createProvider("openai:gpt-5");
    expect(provider.prepareStep).toBeUndefined();
  });
});
