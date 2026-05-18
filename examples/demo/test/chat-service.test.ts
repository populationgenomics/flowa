/**
 * In-process smoke test for the deployment-style chat-service entry.
 *
 * The full LLM round-trip is exercised manually via the running demo
 * against a real provider; this test only verifies that the wiring —
 * the generic schema, the fs storage, createApp, the prompt-template
 * loader — composes without runtime errors and that GET /health
 * responds, which is enough to catch a broken import or a typo in
 * the entry script's call shape.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "@flowajs/chat-service/server";
import { createFsStorage } from "@flowajs/chat-service/storage/fs";
import type { LlmProvider } from "@flowajs/chat-service/llm/interface";
import { ArtifactSchema } from "@flowajs/prompts/generic";

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "flowa-demo-chat-"));
});

afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

const stubProvider: LlmProvider = {
  name: "test",
  // The /health endpoint never exercises the model; tests that did would
  // need a real or mocked LanguageModel.
  model: undefined as never,
  providerOptions: {},
};

const promptDir = dirname(
  fileURLToPath(import.meta.resolve("@flowajs/prompts/generic")),
);

describe("chat-service entry wiring", () => {
  test("ArtifactSchema validates a fixture artifact", () => {
    const fixture = {
      category: "acmg_classification",
      classification: "Pathogenic",
      classification_rationale: "test",
      description: "test",
      notes: "test",
      papers: [],
      claims: [],
    };
    const result = ArtifactSchema.safeParse(fixture);
    expect(result.success).toBe(true);
  });

  test("createApp + fs storage + generic schema returns a Hono app", () => {
    const app = createApp({
      storage: createFsStorage({ root: dataRoot }),
      provider: stubProvider,
      schema: ArtifactSchema,
      jwtSecret: "test-secret",
      promptDir,
    });
    expect(typeof app.fetch).toBe("function");
  });

  test("GET /health returns 200 + status: ok", async () => {
    const app = createApp({
      storage: createFsStorage({ root: dataRoot }),
      provider: stubProvider,
      schema: ArtifactSchema,
      jwtSecret: "test-secret",
      promptDir,
    });

    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });

  test("POST /sessions errors cleanly when no aggregate is on disk", async () => {
    // No fixture written → loadQueryResult returns null → 422 with a
    // descriptive error. This is the failure mode a deployment hits when
    // booted against an empty storage root; verifying the error path is
    // cheap and catches regressions in the request validation chain.
    const app = createApp({
      storage: createFsStorage({ root: dataRoot }),
      provider: stubProvider,
      schema: ArtifactSchema,
      jwtSecret: "test-secret",
      promptDir,
    });

    const res = await app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: "NM_001035_3-c_14174A_G",
        user_id: "leo@example.com",
        category: "acmg_classification",
        initial_artifact: "{}",
        initial_version: 0,
      }),
    });
    expect(res.status).toBe(422);
  });

  test("POST /sessions succeeds against a minimal fixture aggregate", async () => {
    // Seed the minimum chat-service expects: query.json (DOI list) +
    // aggregate.json (with one matching category). Per-paper extracts
    // are read on-demand by tools, not at session creation.
    const variantId = "NM_001035_3-c_14174A_G";
    writeFileSync(
      join(makeDir(dataRoot, "assessments", variantId), "query.json"),
      JSON.stringify({ dois: [] }),
    );
    writeFileSync(
      join(dataRoot, "assessments", variantId, "aggregate.json"),
      JSON.stringify({
        results: [
          {
            category: "acmg_classification",
            classification: "Pathogenic",
            classification_rationale: "demo",
            description: "demo",
            notes: "demo",
            papers: [],
            claims: [],
          },
        ],
      }),
    );

    const initialArtifact = JSON.stringify({
      category: "acmg_classification",
      classification: "Pathogenic",
      classification_rationale: "demo",
      description: "demo",
      notes: "demo",
      papers: [],
      claims: [],
    });

    const app = createApp({
      storage: createFsStorage({ root: dataRoot }),
      provider: stubProvider,
      schema: ArtifactSchema,
      jwtSecret: "test-secret",
      promptDir,
    });

    const res = await app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: variantId,
        user_id: "leo@example.com",
        category: "acmg_classification",
        initial_artifact: initialArtifact,
        initial_version: 0,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session_id: string;
      token: string;
      expires_at: string;
    };
    expect(body.session_id).toMatch(/^[0-9a-f-]+$/);
    expect(body.token.split(".")).toHaveLength(3);
  });
});

function makeDir(...segments: string[]): string {
  const path = join(...segments);
  mkdirSync(path, { recursive: true });
  return path;
}
