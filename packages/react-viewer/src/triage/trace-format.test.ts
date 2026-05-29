import { describe, it, expect } from "vitest";
import {
  formatPayload,
  summarize,
  toolDisplayName,
  toolStatus,
  truncate,
} from "./trace-format";

describe("toolDisplayName", () => {
  it("uses toolName for dynamic-tool parts", () => {
    expect(
      toolDisplayName({ type: "dynamic-tool", toolName: "searchPaper" }),
    ).toBe("searchPaper");
  });
  it("derives the name from a typed tool- part", () => {
    expect(toolDisplayName({ type: "tool-str_replace" })).toBe("str_replace");
  });
});

describe("toolStatus", () => {
  it.each([
    ["input-streaming", "spinner"],
    ["input-available", "spinner"],
    ["approval-responded", "spinner"],
    ["approval-requested", "pending"],
    ["output-available", "success"],
    ["output-error", "error"],
    ["output-denied", "denied"],
    ["something-the-sdk-adds-later", "neutral"],
  ])("maps %s -> %s", (state, kind) => {
    expect(toolStatus(state).kind).toBe(kind);
  });
});

describe("truncate", () => {
  it("appends an ellipsis past the cap", () => {
    expect(truncate("abcdef", 3)).toBe("abc…");
  });
  it("leaves short strings untouched", () => {
    expect(truncate("ab", 3)).toBe("ab");
  });
});

describe("summarize", () => {
  it("returns empty for null/undefined", () => {
    expect(summarize(null)).toBe("");
    expect(summarize(undefined)).toBe("");
  });
  it("caps long strings", () => {
    expect(summarize("x".repeat(200)).length).toBeLessThanOrEqual(81);
  });
  it("shows the first scalar field of an object input", () => {
    expect(summarize({ paperId: "Smith2020", pattern: "BRCA" })).toContain(
      "paperId",
    );
  });
  it("lists keys with array counts when there is no scalar field", () => {
    expect(summarize({ paperIds: ["a", "b", "c"] })).toBe("paperIds (3)");
  });
  it("shows the first line of a multi-line string output", () => {
    expect(summarize("2 matches in Ron2025:\n12: foo\n34: bar")).toBe(
      "2 matches in Ron2025:",
    );
  });
  it("collapses whitespace in a scalar field value", () => {
    expect(summarize({ old_str: "line one\nline two" })).toBe(
      "old_str: line one line two",
    );
  });
});

describe("formatPayload", () => {
  it("pretty-prints objects", () => {
    expect(formatPayload({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
  it("passes strings through", () => {
    expect(formatPayload("hello")).toBe("hello");
  });
  it("truncates large payloads with a marker and stays bounded", () => {
    const out = formatPayload({ artifact_yaml: "x".repeat(5000) });
    expect(out).toContain("truncated");
    expect(out.length).toBeLessThan(2200);
  });
  it("stringifies non-JSON scalars safely", () => {
    expect(formatPayload(NaN)).toBe("NaN");
  });
});
