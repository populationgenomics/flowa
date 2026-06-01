import { describe, it, expect } from "vitest";
import { codePointAnchorToUtf16 } from "./offsets";

describe("codePointAnchorToUtf16", () => {
  it("is the identity for all-BMP text", () => {
    const md = "The variant p.Arg175His is pathogenic.";
    const start = md.indexOf("p.Arg175His");
    const end = start + "p.Arg175His".length;
    // All-BMP: code-point offsets equal UTF-16 offsets.
    expect(codePointAnchorToUtf16(md, { start, end })).toEqual({ start, end });
  });

  it("shifts offsets past an astral character", () => {
    // "𝑝" (U+1D45D) is one code point but two UTF-16 units.
    const md = "𝑝 value is 0.001";
    expect([...md][0]).toBe("𝑝");
    // "value" starts at code point 2 ("𝑝", " ", then "value").
    const cpStart = 2;
    const cpEnd = cpStart + "value".length;
    const u16 = codePointAnchorToUtf16(md, { start: cpStart, end: cpEnd });
    // UTF-16: the astral char occupies 2 units, so "value" begins at index 3.
    expect(u16).toEqual({ start: 3, end: 8 });
    // The converted offsets slice the right substring; the raw code-point
    // offsets would not.
    expect(md.slice(u16.start, u16.end)).toBe("value");
    expect(md.slice(cpStart, cpEnd)).not.toBe("value");
  });

  it("accumulates the shift across multiple astral characters", () => {
    const md = "😀😀 tail"; // two astral chars (2 units each), then " tail"
    // "tail" is code points 3..7. UTF-16 start = 2 + 2 + 1 = 5.
    const u16 = codePointAnchorToUtf16(md, { start: 3, end: 7 });
    expect(md.slice(u16.start, u16.end)).toBe("tail");
  });

  it("clamps offsets that run past the end of the string", () => {
    const md = "short";
    expect(codePointAnchorToUtf16(md, { start: 2, end: 999 })).toEqual({
      start: 2,
      end: md.length,
    });
  });

  it("handles a zero-length anchor at the start", () => {
    expect(codePointAnchorToUtf16("abc", { start: 0, end: 0 })).toEqual({
      start: 0,
      end: 0,
    });
  });
});
