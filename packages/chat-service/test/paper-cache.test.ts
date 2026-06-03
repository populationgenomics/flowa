import { describe, expect, test } from "vitest";
import type { LanguageModel } from "ai";
import { buildTools } from "../src/chat.js";
import type { SessionContext } from "../src/session.js";
import { ArtifactSchema } from "../src/artifact.js";
import type { LlmProvider } from "../src/llm/interface.js";
import type { Storage } from "../src/storage/interface.js";

const stubProvider: LlmProvider = {
  name: "test",
  model: undefined as unknown as LanguageModel,
  providerOptions: {},
};

interface FakeStorage extends Storage {
  readTextCalls: string[];
  setMarkdown(doi: string, body: string | null): void;
}

function makeFakeStorage(): FakeStorage {
  const markdownByKey = new Map<string, string | null>();
  const readTextCalls: string[] = [];
  return {
    prefix: "",
    readTextCalls,
    setMarkdown(doi, body) {
      markdownByKey.set(`papers/${encodeURIComponent(doi)}/merged.md`, body);
    },
    read: async () => null,
    readText: async (key: string) => {
      readTextCalls.push(key);
      return markdownByKey.has(key) ? (markdownByKey.get(key) ?? null) : null;
    },
    readJson: async () => null,
    write: async () => {},
    writeJson: async () => {},
    writeIfAbsent: async () => {},
    exists: async () => false,
    list: async () => [],
  };
}

const BASE_YAML = [
  `category: cat-A`,
  `description: short summary`,
  `notes: short`,
  `papers:`,
  `  - paper_id: Smith2024`,
  `    rank_rationale: most important`,
  `claims:`,
  `  - paper_id: Smith2024`,
  `    text: foundational claim about the variant`,
  `    citations:`,
  `      - quote: foundational claim about the variant in five unrelated families`,
].join("\n");

function makeSession(): SessionContext {
  return {
    id: "sess-1",
    variantId: "v/1/t",
    userId: "u1",
    paperIds: { Smith2024: "10.1/smith" },
    systemPrompt: "",
    expiresAt: new Date(Date.now() + 60_000),
    artifactYaml: BASE_YAML,
    artifactVersion: 0,
    artifactDirty: false,
    category: "cat-A",
    aggregateCategories: ["cat-A"],
    locationCache: new Map(),
    paperMarkdownCache: new Map(),
  };
}

const PAPER_BODY = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join(
  "\n",
);

// loadMarkdown tries merged.md (the assembled artifact) first, then falls back to
// main.md (the bare transcription) — mirroring flowa.storage.full_md_url.
const MERGED_KEY = `papers/${encodeURIComponent("10.1/smith")}/merged.md`;
const MAIN_KEY = `papers/${encodeURIComponent("10.1/smith")}/main.md`;

describe("per-session paper-markdown cache", () => {
  test("first searchPaper call triggers one loadMarkdown invocation", async () => {
    const session = makeSession();
    const storage = makeFakeStorage();
    storage.setMarkdown("10.1/smith", PAPER_BODY);
    const tools = buildTools({
      session,
      storage,
      provider: stubProvider,
      schema: ArtifactSchema,
    });

    await tools.searchPaper.execute({
      paperId: "Smith2024",
      pattern: "line 5",
    });
    expect(storage.readTextCalls).toEqual([MERGED_KEY]);
    expect(session.paperMarkdownCache.get("Smith2024")).toBe(PAPER_BODY);
  });

  test("second call on the same paper is a cache hit (no extra storage read)", async () => {
    const session = makeSession();
    const storage = makeFakeStorage();
    storage.setMarkdown("10.1/smith", PAPER_BODY);
    const tools = buildTools({
      session,
      storage,
      provider: stubProvider,
      schema: ArtifactSchema,
    });

    await tools.searchPaper.execute({
      paperId: "Smith2024",
      pattern: "line 5",
    });
    await tools.viewPaper.execute({
      paperId: "Smith2024",
      view_range: [1, 10],
    });
    await tools.searchPaper.execute({
      paperId: "Smith2024",
      pattern: "line 7",
    });

    expect(storage.readTextCalls).toEqual([MERGED_KEY]);
  });

  test("unknown paperId returns an error and never touches storage", async () => {
    const session = makeSession();
    const storage = makeFakeStorage();
    const tools = buildTools({
      session,
      storage,
      provider: stubProvider,
      schema: ArtifactSchema,
    });

    const searchResult = await tools.searchPaper.execute({
      paperId: "Unknown2099",
      pattern: "anything",
    });
    expect(searchResult).toEqual({
      error: "Unknown paper ID or full text not available: Unknown2099",
    });

    const viewResult = await tools.viewPaper.execute({
      paperId: "Unknown2099",
    });
    expect(viewResult).toEqual({
      error: "Unknown paper ID or full text not available: Unknown2099",
    });

    expect(storage.readTextCalls).toEqual([]);
    expect(session.paperMarkdownCache.size).toBe(0);
  });

  test("known paperId with missing markdown returns error and does not insert into cache", async () => {
    const session = makeSession();
    const storage = makeFakeStorage();
    // Deliberately do NOT call setMarkdown — storage.readText returns null.
    const tools = buildTools({
      session,
      storage,
      provider: stubProvider,
      schema: ArtifactSchema,
    });

    const first = await tools.searchPaper.execute({
      paperId: "Smith2024",
      pattern: "line 1",
    });
    expect(first).toEqual({
      error: "Unknown paper ID or full text not available: Smith2024",
    });

    expect(session.paperMarkdownCache.size).toBe(0);

    // A second call still hits storage — nothing was cached.
    const second = await tools.searchPaper.execute({
      paperId: "Smith2024",
      pattern: "line 1",
    });
    expect(second).toEqual({
      error: "Unknown paper ID or full text not available: Smith2024",
    });
    // Each loadMarkdown tries merged.md then main.md; the missing paper is retried
    // (not cached), so two attempts -> four reads.
    expect(storage.readTextCalls).toEqual([
      MERGED_KEY,
      MAIN_KEY,
      MERGED_KEY,
      MAIN_KEY,
    ]);
  });
});
