/**
 * M4 render smoke test: load the real `prompts/generic/aggregate_edit_prompt.txt`
 * and render it with a schema that mirrors `prompts/generic/aggregate_edit_schema.ts`
 * (citation-grounded core via `artifactFields` + `classification` +
 * `classification_rationale`). Verifies the deployment-extension pattern
 * compiles, the prompt template renders without `throwOnUndefined` errors,
 * the JSON Schema serialisation works, and a hand-crafted fixture artifact
 * validates against the schema.
 *
 * Does NOT import `prompts/generic/aggregate_edit_schema.ts` directly because
 * that file imports `@flowajs/chat-service` by name (the public contract for
 * external deployments) and will only resolve once the package is built. The
 * test reconstructs the same schema inline using `artifactFields` from
 * `../src/artifact.js`, which exercises the same contract.
 */

import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import nunjucks from "nunjucks";
import { z } from "zod";
import { artifactFields, schemaForPrompt } from "../src/artifact.js";
import { loadEditPromptTemplate } from "../src/prompts.js";

const GENERIC_PROMPT_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "prompts",
  "generic",
);

// Mirrors prompts/generic/aggregate_edit_schema.ts. Kept inline (rather than
// imported) because that file imports @flowajs/chat-service by name; we
// exercise the same shape via artifactFields directly.
const GenericArtifactSchema = z.object({
  ...artifactFields,
  classification: z
    .string()
    .describe(
      "ACMG classification term: Pathogenic, Likely Pathogenic, VUS, Likely Benign, or Benign.",
    ),
  classification_rationale: z
    .string()
    .describe(
      "One short clause naming the deciding factor for this classification.",
    ),
});

const promptEnv = new nunjucks.Environment(undefined, {
  autoescape: false,
  throwOnUndefined: true,
});

const FIXTURE_ARTIFACT = {
  category: "acmg_classification",
  classification: "VUS",
  classification_rationale: "Single VUS ClinVar submission, no literature.",
  description: "This variant has no previous evidence of pathogenicity.",
  notes:
    "- **ClinVar**: 1× VUS (Lab A, 2024-03-12, criteria provided).\n- **Literature**: no papers describing this variant.",
  papers: [],
  claims: [],
};

const FIXTURE_PAPER_INDEX = "(no papers in scope)";

const FIXTURE_INITIAL_ARTIFACT = `   1\tcategory: acmg_classification
   2\tclassification: VUS
   3\tclassification_rationale: Single VUS ClinVar submission, no literature.
   4\tdescription: This variant has no previous evidence of pathogenicity.
   5\tnotes: |
   6\t  - **ClinVar**: 1× VUS.
   7\tpapers: []
   8\tclaims: []
`;

describe("prompts/generic/aggregate_edit_prompt.txt", () => {
  test("renders against the generic deployment schema without errors", () => {
    const template = loadEditPromptTemplate(GENERIC_PROMPT_DIR);
    const rendered = promptEnv.renderString(template, {
      artifact_schema: schemaForPrompt(GenericArtifactSchema),
      paper_index: FIXTURE_PAPER_INDEX,
      initial_artifact: FIXTURE_INITIAL_ARTIFACT,
    });

    // No unresolved Nunjucks placeholders.
    expect(rendered).not.toMatch(/\{\{ \w+ \}\}/);

    // Three context vars actually got interpolated.
    expect(rendered).toContain('"$schema"');
    expect(rendered).toContain(FIXTURE_PAPER_INDEX);
    expect(rendered).toContain("classification: VUS");

    // Core flowa-generic field names appear by name in the prompt body
    // (catches accidental drift if a future edit renames a field in the
    // schema but forgets the prompt).
    for (const field of [
      "category",
      "classification",
      "classification_rationale",
      "description",
      "notes",
      "papers",
      "claims",
    ]) {
      expect(rendered).toContain(field);
    }
  });

  test("validates a fixture artifact against the deployment schema", () => {
    const result = GenericArtifactSchema.safeParse(FIXTURE_ARTIFACT);
    expect(result.success).toBe(true);
  });

  test("fails loudly on a fixture artifact missing classification", () => {
    const broken = { ...FIXTURE_ARTIFACT } as Record<string, unknown>;
    delete broken.classification;
    const result = GenericArtifactSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  test("emitted JSON Schema names every core field", () => {
    const json = schemaForPrompt(GenericArtifactSchema);
    for (const field of [
      "category",
      "classification",
      "classification_rationale",
      "description",
      "notes",
      "papers",
      "claims",
    ]) {
      expect(json).toContain(`"${field}"`);
    }
  });
});

describe("prompts/generic/aggregate_edit_schema.ts (companion file)", () => {
  test("file exists and references the documented contract", () => {
    const path = join(GENERIC_PROMPT_DIR, "aggregate_edit_schema.ts");
    const text = readFileSync(path, "utf-8");

    // The deployment-extension pattern from §6.2: spread artifactFields,
    // add deployment fields. If this changes, the prompt's field-name
    // references must move with it.
    expect(text).toContain('from "@flowajs/chat-service"');
    expect(text).toContain("artifactFields");
    expect(text).toContain("classification");
    expect(text).toContain("classification_rationale");
  });
});
