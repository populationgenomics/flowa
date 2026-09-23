import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ToolLoopAgent, isStepCount, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { createProvider } from "../src/llm/factory.js";

// Drives a real multi-step tool loop (the agent chat-service runs) against a
// mock model and inspects the prompt of every model call. Anthropic and
// Bedrock both reject a request carrying more than four cache breakpoints,
// so each call must carry exactly one marker however many steps the loop
// has run.

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  vi.stubEnv("AWS_REGION", "us-east-1");
  vi.stubEnv("AWS_ACCESS_KEY_ID", "test-access");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-secret");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const TOOL_STEPS = 6;

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function toolLoopModel() {
  let call = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      call += 1;
      if (call <= TOOL_STEPS)
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: `call-${call}`,
              toolName: "echo",
              input: JSON.stringify({ value: call }),
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool_use" },
          usage,
          warnings: [],
        };
      return {
        content: [{ type: "text", text: "done" }],
        finishReason: { unified: "stop", raw: "end_turn" },
        usage,
        warnings: [],
      };
    },
  });
}

describe.each([
  ["anthropic:claude-sonnet-4-6", "anthropic", "cacheControl"],
  ["bedrock:au.anthropic.claude-sonnet-4-6", "bedrock", "cachePoint"],
])("%s cache marker across a tool loop", (spec, providerKey, markerKey) => {
  test("every model call carries exactly one marker, on its last message", async () => {
    const provider = await createProvider(spec);
    const model = toolLoopModel();
    const agent = new ToolLoopAgent({
      model,
      tools: {
        echo: tool({
          inputSchema: z.object({ value: z.number() }),
          execute: async ({ value }) => value,
        }),
      },
      stopWhen: isStepCount(TOOL_STEPS + 1),
      prepareStep: provider.prepareStep,
    });
    await agent.generate({ messages: [{ role: "user", content: "start" }] });

    expect(model.doGenerateCalls).toHaveLength(TOOL_STEPS + 1);
    for (const { prompt } of model.doGenerateCalls) {
      const marked = prompt.flatMap((msg, i) =>
        (msg.providerOptions?.[providerKey] as Record<string, unknown>)?.[
          markerKey
        ]
          ? [i]
          : [],
      );
      expect(marked).toEqual([prompt.length - 1]);
    }
  });
});
