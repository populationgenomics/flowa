import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import type { ModelMessage } from "ai";
import type { LlmProvider } from "./interface.js";

export interface BedrockProviderOptions {
  modelId: string;
  /**
   * Optional Bedrock application inference profile ARN. When set, the
   * profile ARN is used as the actual API target — Bedrock routes
   * through the profile for cost attribution. `modelId` remains the
   * informative foundation-model identifier carried into telemetry and
   * logs.
   *
   * The Vercel AI SDK's `bedrock(modelId)` factory accepts only one
   * identifier, so when a profile is present we hand the ARN where the
   * foundation modelId would have gone; chat-service keeps `modelId`
   * separately for the human-readable role.
   */
  inferenceProfile?: string;
  /** Optional pre-built provider client. */
  client?: ReturnType<typeof createAmazonBedrock>;
}

/**
 * Amazon Bedrock provider. `providerOptions.bedrock` carries Bedrock's
 * `additionalModelRequestFields` for adaptive thinking + medium-effort
 * output config.
 *
 * `prepareStep` injects a `cachePoint` on the last message so everything
 * before it (system prompt + conversation history + prior tool results)
 * is cached as a prefix. On the next step or turn, the unchanged prefix
 * is read from cache at ~90% lower cost. The same caching pattern is
 * implemented in `./anthropic.ts` with the equivalent `cacheControl`
 * marker.
 */
export async function createBedrockProvider(
  options: BedrockProviderOptions,
): Promise<LlmProvider> {
  let client = options.client;
  if (!client) {
    // The Vercel AI SDK's `@ai-sdk/amazon-bedrock` doesn't use the AWS
    // SDK's standard credential chain by default — it expects explicit
    // keys or a `credentialProvider` function. Wire `fromNodeProviderChain`
    // here so AWS_PROFILE / SSO / IRSA / env-var auth all "just work" via
    // the env-driven entry. Deployments needing custom cred-mint flows
    // (OIDC → STS, etc.) construct their own client with whatever
    // provider matches their setup and pass it in via `options.client`.
    const { fromNodeProviderChain } =
      await import("@aws-sdk/credential-providers");
    client = createAmazonBedrock({
      credentialProvider: fromNodeProviderChain(),
    });
  }
  const apiTarget = options.inferenceProfile ?? options.modelId;
  return {
    name: "aws.bedrock",
    model: client(apiTarget),
    providerOptions: {
      bedrock: {
        additionalModelRequestFields: {
          thinking: { type: "adaptive" },
          output_config: { effort: "medium" },
        },
      },
    },
    prepareStep: ({ messages }: { messages: ModelMessage[] }) => ({
      messages: messages.map((msg, i) =>
        i === messages.length - 1
          ? {
              ...msg,
              providerOptions: {
                ...(msg.providerOptions ?? {}),
                bedrock: { cachePoint: { type: "default" as const } },
              },
            }
          : msg,
      ),
    }),
  };
}
