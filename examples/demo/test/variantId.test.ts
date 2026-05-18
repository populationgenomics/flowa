import { describe, expect, test } from "vitest";
import { deriveVariantId, isValidVariantId, slug } from "../src/lib/variantId";

describe("slug", () => {
  test("keeps letters, digits, underscore as-is", () => {
    expect(slug("ABC_xyz_123")).toBe("ABC_xyz_123");
  });

  test("replaces dots, colons, comparison operators with underscores", () => {
    expect(slug("NM_001035.3")).toBe("NM_001035_3");
    expect(slug("c.14174A>G")).toBe("c_14174A_G");
  });

  test("collapses parentheses and dashes too", () => {
    expect(slug("p.(Tyr4725Cys)")).toBe("p__Tyr4725Cys_");
    expect(slug("c.14174A>G;p.Y4725C")).toBe("c_14174A_G_p_Y4725C");
  });
});

describe("deriveVariantId", () => {
  test("joins slugged transcript and c.-form with a dash", () => {
    expect(deriveVariantId("NM_001035.3", "c.14174A>G")).toBe(
      "NM_001035_3-c_14174A_G",
    );
  });

  test("transcript versions don't collide", () => {
    const v2 = deriveVariantId("NM_001035.2", "c.14174A>G");
    const v3 = deriveVariantId("NM_001035.3", "c.14174A>G");
    expect(v2).not.toBe(v3);
  });

  test("derivation is deterministic for re-analyze", () => {
    const first = deriveVariantId("NM_001035.3", "c.14174A>G");
    const again = deriveVariantId("NM_001035.3", "c.14174A>G");
    expect(first).toBe(again);
  });

  test("output is always a path-safe slug", () => {
    expect(isValidVariantId(deriveVariantId("NM_001035.3", "c.14174A>G"))).toBe(
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
    expect(isValidVariantId("NM_001035_3-c_14174A_G")).toBe(true);
    expect(isValidVariantId("NM_007294_4-c_5266dupC")).toBe(true);
  });

  test("rejects path traversal attempts", () => {
    expect(isValidVariantId("../etc/passwd")).toBe(false);
    expect(isValidVariantId("foo/bar")).toBe(false);
    expect(isValidVariantId("foo\\bar")).toBe(false);
  });

  test("rejects un-slugged HGVS notation", () => {
    expect(isValidVariantId("NM_001035.3:c.14174A>G")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(isValidVariantId("")).toBe(false);
  });
});
