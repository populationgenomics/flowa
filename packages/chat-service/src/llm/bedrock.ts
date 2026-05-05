import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import type { ModelMessage } from "ai";
import type { LlmProvider } from "./interface.js";

export interface BedrockProviderOptions {
  modelId: string;
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
export function createBedrockProvider(
  options: BedrockProviderOptions,
): LlmProvider {
  const client = options.client ?? createAmazonBedrock({});
  return {
    name: "aws.bedrock",
    model: client(options.modelId),
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
