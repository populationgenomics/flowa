import { describe, expect, test } from "vitest";
import type { LanguageModel } from "ai";
import {
  buildTools,
  renderTriageStateBlock,
  validateArtifactContent,
  TriageStateSchema,
} from "../src/chat.js";
import type { SessionContext } from "../src/session.js";
import { type Artifact, ArtifactSchema } from "../src/artifact.js";
import type { LlmProvider } from "../src/llm/interface.js";
import type { Storage } from "../src/storage/interface.js";

// ---------------------------------------------------------------------------
// Stubs — buildTools requires storage + provider + schema. The tests in this
// file exercise only str_replace / insert / write / view / search and the
// pure validators, none of which touch storage or invoke the model. Stub
// them with no-op implementations.
// ---------------------------------------------------------------------------

const stubProvider: LlmProvider = {
  name: "test",
  // queryPapers / loadFullPaper are the only paths that touch model. Tests
  // here don't exercise them, so an unwired model is fine.
  model: undefined as unknown as LanguageModel,
  providerOptions: {},
};

const stubStorage: Storage = {
  prefix: "",
  read: async () => null,
  readText: async () => null,
  readJson: async () => null,
  write: async () => {},
  writeJson: async () => {},
  writeIfAbsent: async () => {},
  exists: async () => false,
  list: async () => [],
};

function makeTools(session: SessionContext) {
  return buildTools({
    session,
    storage: stubStorage,
    provider: stubProvider,
    schema: ArtifactSchema,
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_YAML = [
  `category: cat-A`,
  `description: short summary`,
  `notes: |-`,
  `  paragraph one`,
  `  paragraph two`,
  `papers:`,
  `  - paper_id: Smith2024`,
  `    rank_rationale: most important`,
  `claims:`,
  `  - paper_id: Smith2024`,
  `    text: foundational claim about the variant`,
  `    citations:`,
  `      - quote: foundational claim about the variant in five unrelated families`,
].join("\n");

function makeSession(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    id: "sess-1",
    variantId: "v/1/t",
    userId: "u1",
    // Default session paperIds mirrors BASE_YAML so validateArtifactContent's
    // paper_id_mapping cross-check passes. Tests that rewrite to new papers
    // override this to include those IDs.
    paperIds: { Smith2024: "10.1/smith" },
    systemPrompt: "",
    expiresAt: new Date(Date.now() + 60_000),
    artifactYaml: BASE_YAML,
    artifactVersion: 0,
    artifactDirty: false,
    category: "cat-A",
    aggregateCategories: ["cat-A"],
    bboxCache: new Map(),
    ...overrides,
  };
}

function buildArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    category: "cat-A",
    description: "d",
    notes: "n",
    papers: [{ paper_id: "Smith2024", rank_rationale: "top" }],
    claims: [
      {
        paper_id: "Smith2024",
        text: "a claim",
        citations: [{ quote: "verbatim quote long enough" }],
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// str_replace — match counting
// ---------------------------------------------------------------------------

describe("str_replace match counting", () => {
  test("no match returns is_error with 'not found'", async () => {
    const session = makeSession();
    const tools = makeTools(session);
    const result = await tools.str_replace.execute({
      old_str: "nonexistent",
      new_str: "whatever",
    });
    expect(result).toEqual({
      error: "old_str not found in artifact.",
      is_error: true,
    });
    expect(session.artifactDirty).toBe(false);
    expect(session.artifactYaml).toBe(BASE_YAML);
  });

  test("multiple matches returns is_error with count", async () => {
    const session = makeSession();
    const tools = makeTools(session);
    const result = await tools.str_replace.execute({
      old_str: "paragraph",
      new_str: "section",
    });
    expect((result as { is_error: boolean }).is_error).toBe(true);
    expect((result as { error: string }).error).toMatch(/Found 2 matches/);
    expect(session.artifactDirty).toBe(false);
  });

  test("unique match updates artifact and sets dirty", async () => {
    const session = makeSession();
    const tools = makeTools(session);
    const result = await tools.str_replace.execute({
      old_str: "description: short summary",
      new_str: "description: updated summary",
    });
    expect(result).toBe("Edit applied successfully.");
    expect(session.artifactDirty).toBe(true);
    expect(session.artifactYaml).toContain("description: updated summary");
    expect(session.artifactYaml).not.toContain("description: short summary");
  });
});

// ---------------------------------------------------------------------------
// str_replace — validation (via validateAndCommit)
// ---------------------------------------------------------------------------

describe("str_replace validation", () => {
  test("edit producing invalid YAML is rejected", async () => {
    const session = makeSession();
    const tools = makeTools(session);
    const result = await tools.str_replace.execute({
      old_str: "claims:",
      new_str: "claims: [\n  - bad: [unterminated",
    });
    expect((result as { is_error: boolean }).is_error).toBe(true);
    expect((result as { error: string }).error).toMatch(/invalid YAML/i);
    expect(session.artifactDirty).toBe(false);
    expect(session.artifactYaml).toBe(BASE_YAML);
  });

  test("edit removing a required field is rejected by schema", async () => {
    const session = makeSession();
    const tools = makeTools(session);
    const result = await tools.str_replace.execute({
      old_str: "notes: |-\n  paragraph one\n  paragraph two\n",
      new_str: "",
    });
    expect((result as { is_error: boolean }).is_error).toBe(true);
    expect((result as { error: string }).error).toMatch(/invalid artifact/i);
    expect((result as { error: string }).error).toMatch(/notes/);
    expect(session.artifactDirty).toBe(false);
  });

  test("category change to an existing aggregate category is rejected", async () => {
    const session = makeSession({ aggregateCategories: ["cat-A", "cat-B"] });
    const tools = makeTools(session);
    const result = await tools.str_replace.execute({
      old_str: `category: cat-A`,
      new_str: `category: cat-B`,
    });
    expect(result).toEqual({
      error: "Category cat-B already has a result for this aggregate.",
      is_error: true,
    });
    expect(session.artifactDirty).toBe(false);
  });

  test("category change to a category NOT in aggregateCategories succeeds", async () => {
    const session = makeSession({ aggregateCategories: ["cat-A"] });
    const tools = makeTools(session);
    const result = await tools.str_replace.execute({
      old_str: `category: cat-A`,
      new_str: `category: cat-C`,
    });
    expect(result).toBe("Edit applied successfully.");
    expect(session.artifactDirty).toBe(true);
    expect(session.artifactYaml).toContain(`category: cat-C`);
  });
});

// ---------------------------------------------------------------------------
// insert
// ---------------------------------------------------------------------------

describe("insert", () => {
  test("appends at end of file", async () => {
    const session = makeSession();
    const tools = makeTools(session);
    const lineCount = BASE_YAML.split("\n").length;
    const result = await tools.insert.execute({
      insert_line: lineCount,
      new_str: "# trailing comment",
    });
    expect(result).toBe("Edit applied successfully.");
    expect(session.artifactDirty).toBe(true);
    expect(session.artifactYaml.endsWith("# trailing comment")).toBe(true);
  });

  test("edit producing schema-invalid artifact is rejected", async () => {
    const session = makeSession();
    const tools = makeTools(session);
    // Append a top-level `papers: 42` after the existing valid `papers: [...]`.
    // yaml.parse keeps the last value; schema then rejects (papers must be
    // an array of objects).
    const lineCount = session.artifactYaml.split("\n").length;
    const result = await tools.insert.execute({
      insert_line: lineCount,
      new_str: "papers: 42",
    });
    expect((result as { is_error: boolean }).is_error).toBe(true);
    expect(session.artifactDirty).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// search (tool wrapping around searchArtifact)
// ---------------------------------------------------------------------------

describe("search", () => {
  test("no matches returns formatted 'No matches' string", async () => {
    const session = makeSession();
    const tools = makeTools(session);
    const result = await tools.search.execute({
      pattern: "nothingeverwasthishere",
    });
    expect(result).toBe(`No matches for "nothingeverwasthishere".`);
  });

  test("one match returns singular 'match' label", async () => {
    const session = makeSession();
    const tools = makeTools(session);
    const result = await tools.search.execute({ pattern: "description" });
    expect(result as string).toMatch(/^1 match:\n/);
  });

  test("multiple matches return plural 'matches' label with count", async () => {
    const session = makeSession();
    const tools = makeTools(session);
    const result = await tools.search.execute({ pattern: "paragraph" });
    expect(result as string).toMatch(/^2 matches:\n/);
  });
});

// ---------------------------------------------------------------------------
// write tool
// ---------------------------------------------------------------------------

const REWRITTEN_YAML = [
  `category: cat-B`,
  `description: updated short`,
  `notes: updated notes`,
  `papers:`,
  `  - paper_id: Jones2025`,
  `    rank_rationale: now the most load-bearing source`,
  `claims:`,
  `  - paper_id: Jones2025`,
  `    text: new claim from a different paper`,
  `    citations:`,
  `      - quote: new claim from a different paper supported by a long quote`,
].join("\n");

describe("write tool", () => {
  test("validates and commits a wholesale rewrite", async () => {
    const session = makeSession({
      aggregateCategories: ["cat-A"],
      paperIds: { Smith2024: "10.1/smith", Jones2025: "10.1/jones" },
    });
    const tools = makeTools(session);
    const result = await tools.write.execute({ artifact_yaml: REWRITTEN_YAML });
    expect(result).toBe("Edit applied successfully.");
    expect(session.artifactDirty).toBe(true);
    expect(session.artifactYaml).toBe(REWRITTEN_YAML);
  });

  test("invalid YAML is rejected", async () => {
    const session = makeSession();
    const tools = makeTools(session);
    const result = await tools.write.execute({ artifact_yaml: "not: [valid" });
    expect((result as { is_error: boolean }).is_error).toBe(true);
    expect(session.artifactDirty).toBe(false);
    expect(session.artifactYaml).toBe(BASE_YAML);
  });

  test("schema-invalid artifact is rejected", async () => {
    const session = makeSession();
    const tools = makeTools(session);
    // Missing required fields (notes, claims) → schema rejection.
    const result = await tools.write.execute({
      artifact_yaml: `category: cat-A\ndescription: d\npapers: []\n`,
    });
    expect((result as { is_error: boolean }).is_error).toBe(true);
    expect((result as { error: string }).error).toMatch(/invalid artifact/i);
    expect(session.artifactDirty).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Content validation
// ---------------------------------------------------------------------------

describe("validateArtifactContent", () => {
  test("claim with unknown paper_id is flagged", () => {
    const errs = validateArtifactContent(
      buildArtifact({
        claims: [
          {
            paper_id: "Unknown2024",
            text: "a claim",
            citations: [{ quote: "verbatim quote long enough" }],
          },
        ],
      }),
    );
    expect(errs.join(" | ")).toMatch(/Unknown2024/);
  });

  test("duplicate paper_id in papers[] is flagged", () => {
    const errs = validateArtifactContent(
      buildArtifact({
        papers: [
          { paper_id: "Smith2024", rank_rationale: "top" },
          { paper_id: "Smith2024", rank_rationale: "dup" },
        ],
      }),
    );
    expect(errs.join(" | ")).toMatch(/duplicate paper_id/);
  });

  test("#cite quote that does not match any claim citation is flagged", () => {
    const errs = validateArtifactContent(
      buildArtifact({
        notes:
          'Summary: [link](#cite:Smith2024 "a quote that does not appear on any claim").',
      }),
    );
    expect(errs.join(" | ")).toMatch(/quote referenced by #cite:Smith2024/);
  });

  test("matching #cite quote passes", () => {
    const errs = validateArtifactContent(
      buildArtifact({
        notes:
          'See [here](#cite:Smith2024 "verbatim quote long enough") for details.',
      }),
    );
    expect(errs).toEqual([]);
  });

  test("#cite to unknown paper_id is flagged", () => {
    const errs = validateArtifactContent(
      buildArtifact({
        notes:
          'See [here](#cite:Unknown2024 "verbatim quote long enough") for details.',
      }),
    );
    expect(errs.join(" | ")).toMatch(/unknown paper_id/);
  });

  test("claim groups out of papers[] order are flagged", () => {
    const errs = validateArtifactContent(
      buildArtifact({
        papers: [
          { paper_id: "Smith2024", rank_rationale: "first" },
          { paper_id: "Jones2023", rank_rationale: "second" },
        ],
        claims: [
          {
            paper_id: "Jones2023",
            text: "c1",
            citations: [{ quote: "q1 long enough" }],
          },
          {
            paper_id: "Smith2024",
            text: "c2",
            citations: [{ quote: "q2 long enough" }],
          },
        ],
      }),
    );
    expect(errs.join(" | ")).toMatch(/match papers\[\] order/);
  });

  test("interleaved claim groups are flagged", () => {
    const errs = validateArtifactContent(
      buildArtifact({
        papers: [
          { paper_id: "Smith2024", rank_rationale: "first" },
          { paper_id: "Jones2023", rank_rationale: "second" },
        ],
        claims: [
          {
            paper_id: "Smith2024",
            text: "s1",
            citations: [{ quote: "q1 long enough" }],
          },
          {
            paper_id: "Jones2023",
            text: "j1",
            citations: [{ quote: "q2 long enough" }],
          },
          {
            paper_id: "Smith2024",
            text: "s2",
            citations: [{ quote: "q3 long enough" }],
          },
        ],
      }),
    );
    expect(errs.join(" | ")).toMatch(/grouped contiguously/);
  });

  test("papers[] paper_id outside the session's mapping is flagged", () => {
    const errs = validateArtifactContent(
      buildArtifact({
        papers: [{ paper_id: "Smith2024", rank_rationale: "top" }],
      }),
      new Set(["Jones2023"]),
    );
    expect(errs.join(" | ")).toMatch(/unknown paper_id="Smith2024"/);
    expect(errs.join(" | ")).toMatch(/paper_id_mapping/);
  });

  test("paper_id_mapping cross-check is skipped when validPaperIds is omitted", () => {
    // Backwards compatibility with callers that don't pass the mapping set.
    const errs = validateArtifactContent(
      buildArtifact({
        papers: [{ paper_id: "Smith2024", rank_rationale: "top" }],
      }),
    );
    expect(errs).toEqual([]);
  });

  test("every papers[] entry present in validPaperIds passes the cross-check", () => {
    const errs = validateArtifactContent(
      buildArtifact({
        papers: [{ paper_id: "Smith2024", rank_rationale: "top" }],
      }),
      new Set(["Smith2024", "Jones2023"]),
    );
    expect(errs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TriageStateSchema
// ---------------------------------------------------------------------------

describe("TriageStateSchema", () => {
  test("rejects claim_index = 0 (indexes are 1-based)", () => {
    const result = TriageStateSchema.safeParse({
      accepted: [{ paper_id: "Smith2024", claim_index: 0 }],
      rejected: [],
      papers_done: [],
      comments: [],
    });
    expect(result.success).toBe(false);
  });

  test("rejects negative claim_index", () => {
    const result = TriageStateSchema.safeParse({
      accepted: [],
      rejected: [{ paper_id: "Smith2024", claim_index: -3 }],
      papers_done: [],
      comments: [],
    });
    expect(result.success).toBe(false);
  });

  test("rejects claim_index = 0 in comments", () => {
    const result = TriageStateSchema.safeParse({
      accepted: [],
      rejected: [],
      papers_done: [],
      comments: [{ paper_id: "Smith2024", claim_index: 0, body: "x" }],
    });
    expect(result.success).toBe(false);
  });

  test("accepts positive claim_index", () => {
    const result = TriageStateSchema.safeParse({
      accepted: [{ paper_id: "Smith2024", claim_index: 1 }],
      rejected: [{ paper_id: "Smith2024", claim_index: 2 }],
      papers_done: ["Jones2023"],
      comments: [{ paper_id: "Smith2024", claim_index: 1, body: "note" }],
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Triage state block rendering
// ---------------------------------------------------------------------------

describe("renderTriageStateBlock", () => {
  test("null state yields default message", () => {
    const block = renderTriageStateBlock(buildArtifact(), null);
    expect(block).toMatch(/No triage in progress/);
  });

  test("reviewer comments render under their claim", () => {
    const artifact = buildArtifact({
      papers: [{ paper_id: "Smith2024", rank_rationale: "top" }],
      claims: [
        {
          paper_id: "Smith2024",
          text: "claim A",
          citations: [{ quote: "qa long enough for spec" }],
        },
        {
          paper_id: "Smith2024",
          text: "claim B",
          citations: [{ quote: "qb long enough for spec" }],
        },
      ],
    });
    const block = renderTriageStateBlock(artifact, {
      accepted: [],
      rejected: [{ paper_id: "Smith2024", claim_index: 1 }],
      papers_done: [],
      comments: [
        {
          paper_id: "Smith2024",
          claim_index: 1,
          body: "duplicate of Smith2024 Patient 31, already counted in claim B",
        },
        {
          paper_id: "Smith2024",
          claim_index: 2,
          body: "",
        },
      ],
    });
    expect(block).toMatch(/reviewer note: duplicate of Smith2024/);
    // Empty comment body must not produce a note line for claim B.
    const noteLines = block
      .split("\n")
      .filter((l) => l.includes("reviewer note:"));
    expect(noteLines).toHaveLength(1);
  });

  test("reflects accepted/rejected/pending by claim position", () => {
    const artifact = buildArtifact({
      papers: [
        { paper_id: "Smith2024", rank_rationale: "top" },
        { paper_id: "Jones2023", rank_rationale: "second" },
      ],
      claims: [
        {
          paper_id: "Smith2024",
          text: "claim A",
          citations: [{ quote: "qa long enough for spec" }],
        },
        {
          paper_id: "Smith2024",
          text: "claim B",
          citations: [{ quote: "qb long enough for spec" }],
        },
        {
          paper_id: "Jones2023",
          text: "claim C",
          citations: [{ quote: "qc long enough for spec" }],
        },
      ],
    });
    const block = renderTriageStateBlock(artifact, {
      accepted: [{ paper_id: "Smith2024", claim_index: 1 }],
      rejected: [{ paper_id: "Smith2024", claim_index: 2 }],
      papers_done: ["Jones2023"],
      comments: [],
    });
    expect(block).toMatch(/Smith2024.*ACCEPTED.*claim A/);
    expect(block).toMatch(/Smith2024.*REJECTED.*claim B/);
    expect(block).toMatch(/Jones2023.*REJECTED\*.*claim C/);
    expect(block).toMatch(/Jones2023/);
  });
});
