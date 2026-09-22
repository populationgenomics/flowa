import { afterAll, beforeAll, expect, test } from "vitest";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { registerAiSdkTelemetry } from "../src/telemetry.js";

// The AI SDK records spans only through integrations registered
// process-wide, one copy per registration. createApp registers on every
// call, so the registration must be idempotent.

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

beforeAll(() => {
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
});

test("AI SDK calls produce spans once, however often registration runs", async () => {
  registerAiSdkTelemetry();
  registerAiSdkTelemetry();

  const model = new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: "text", text: "hi" }],
      finishReason: { unified: "stop", raw: "end_turn" },
      usage: {
        inputTokens: {
          total: 1,
          noCache: 1,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
      warnings: [],
    },
  });
  await generateText({
    model,
    prompt: "hello",
    telemetry: { functionId: "probe" },
  });

  const spans = exporter.getFinishedSpans();
  expect(spans.length).toBeGreaterThan(0);
  const names = spans.map((s) => s.name);
  expect(new Set(names).size).toBe(names.length);
});
