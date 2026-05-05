import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import nunjucks from "nunjucks";
import { loadEditPromptTemplate } from "../src/prompts.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const promptEnv = new nunjucks.Environment(undefined, {
  autoescape: false,
  throwOnUndefined: true,
});

describe("loadEditPromptTemplate", () => {
  test("renders with all stubs populated", () => {
    const template = loadEditPromptTemplate(FIXTURE_DIR);
    const rendered = promptEnv.renderString(template, {
      artifact_schema: "<<STUB_SCHEMA>>",
      paper_index: "<<STUB_PAPER_INDEX>>",
      initial_artifact: "<<STUB_ARTIFACT>>",
    });

    expect(rendered).toMatch(/<<STUB_SCHEMA>>/);
    expect(rendered).toMatch(/<<STUB_PAPER_INDEX>>/);
    expect(rendered).toMatch(/<<STUB_ARTIFACT>>/);

    // No leaked Jinja2/Nunjucks placeholders.
    expect(rendered).not.toMatch(/\{\{ artifact_schema \}\}/);
    expect(rendered).not.toMatch(/\{\{ paper_index \}\}/);
    expect(rendered).not.toMatch(/\{\{ initial_artifact \}\}/);
  });

  test("fails loudly on a missing context variable", () => {
    const template = loadEditPromptTemplate(FIXTURE_DIR);
    expect(() =>
      promptEnv.renderString(template, {
        artifact_schema: "<<STUB_SCHEMA>>",
        // paper_index intentionally omitted
        initial_artifact: "<<STUB_ARTIFACT>>",
      }),
    ).toThrow(/null or undefined/);
  });
});
