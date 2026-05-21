import { describe, expect, test } from "vitest";
import { deriveVariantId, isValidVariantId, slug } from "../src/lib/variantId";

describe("slug", () => {
  test("keeps letters, digits, underscore as-is", () => {
    expect(slug("ABC_xyz_123")).toBe("ABC_xyz_123");
  });

  test("replaces dots, colons, comparison operators with underscores", () => {
    expect(slug("NM_000152.5")).toBe("NM_000152_5");
    expect(slug("c.1935C>A")).toBe("c_1935C_A");
  });

  test("collapses parentheses and dashes too", () => {
    expect(slug("p.(Asp645Glu)")).toBe("p__Asp645Glu_");
    expect(slug("c.1935C>A;p.D645E")).toBe("c_1935C_A_p_D645E");
  });
});

describe("deriveVariantId", () => {
  test("joins slugged transcript and c.-form with a dash", () => {
    expect(deriveVariantId("NM_000152.5", "c.1935C>A")).toBe(
      "NM_000152_5-c_1935C_A",
    );
  });

  test("transcript versions don't collide", () => {
    const v2 = deriveVariantId("NM_000152.4", "c.1935C>A");
    const v3 = deriveVariantId("NM_000152.5", "c.1935C>A");
    expect(v2).not.toBe(v3);
  });

  test("derivation is deterministic for re-analyze", () => {
    const first = deriveVariantId("NM_000152.5", "c.1935C>A");
    const again = deriveVariantId("NM_000152.5", "c.1935C>A");
    expect(first).toBe(again);
  });

  test("output is always a path-safe slug", () => {
    expect(isValidVariantId(deriveVariantId("NM_000152.5", "c.1935C>A"))).toBe(
      true,
    );
    expect(isValidVariantId(deriveVariantId("NM_007294.4", "c.5266dupC"))).toBe(
      true,
    );
    expect(isValidVariantId(deriveVariantId("NM_002124.4", "c.123G>T"))).toBe(
      true,
    );
  });
});

describe("isValidVariantId", () => {
  test("accepts auto-derived variantIds", () => {
    expect(isValidVariantId("NM_000152_5-c_1935C_A")).toBe(true);
    expect(isValidVariantId("NM_007294_4-c_5266dupC")).toBe(true);
  });

  test("rejects path traversal attempts", () => {
    expect(isValidVariantId("../etc/passwd")).toBe(false);
    expect(isValidVariantId("foo/bar")).toBe(false);
    expect(isValidVariantId("foo\\bar")).toBe(false);
  });

  test("rejects un-slugged HGVS notation", () => {
    expect(isValidVariantId("NM_000152.5:c.1935C>A")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(isValidVariantId("")).toBe(false);
  });
});
