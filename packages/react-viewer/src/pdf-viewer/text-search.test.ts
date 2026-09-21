import { describe, it, expect } from "vitest";
import {
  buildDocumentIndex,
  buildPageIndex,
  normaliseChars,
  queryPattern,
  searchIndex,
  type TextRun,
  type ViewportLike,
} from "./text-search";

/** A 1000×1000 page whose viewport flips y, as pdf.js does, and scales 1:1. */
const viewport: ViewportLike = {
  width: 1000,
  height: 1000,
  convertToViewportPoint: (x, y) => [x, 1000 - y],
};

/** A horizontal run at font size `height`, `x`/`y` being its baseline origin. */
function run(
  str: string,
  x: number,
  y: number,
  width: number,
  height = 10,
  hasEOL = false,
  fontName?: string,
): TextRun {
  return {
    str,
    transform: [height, 0, 0, height, x, y],
    width,
    height,
    hasEOL,
    fontName,
  };
}

describe("buildPageIndex", () => {
  it("joins runs end to end and puts a newline at a marked line end", () => {
    // pdf.js emits the space between words as a run of its own.
    const index = buildPageIndex(
      1,
      [
        run("The", 100, 900, 30),
        run(" ", 130, 900, 5),
        run("proband", 135, 900, 75, 10, true),
        run("carried the variant", 100, 880, 190),
        { type: "beginMarkedContent" },
      ],
      viewport,
    );
    expect(index.text).toBe("The proband\ncarried the variant");
    expect(index.runs.map((r) => [r.start, r.end])).toEqual([
      [0, 3],
      [3, 4],
      [4, 11],
      [12, 31],
    ]);
  });

  it("keeps a word set in two fonts whole", () => {
    // An italic gene symbol glued to a roman suffix comes as two runs.
    const index = buildPageIndex(
      1,
      [
        run("BRCA1", 100, 900, 50, 10, false, "g_italic"),
        run("-associated", 150, 900, 110),
      ],
      viewport,
    );
    expect(index.text).toBe("BRCA1-associated");
    expect(searchIndex([index], "BRCA1-associated").hits).toHaveLength(1);
  });

  it("ignores empty runs but keeps their line ends", () => {
    const index = buildPageIndex(
      1,
      [run("a", 0, 0, 10), run("", 0, 0, 0, 10, true), run("b", 0, 0, 10)],
      viewport,
    );
    expect(index.text).toBe("a\nb");
    expect(index.runs).toHaveLength(2);
  });

  it("normalises typographic characters so a keyboard can reach them", () => {
    const index = buildPageIndex(
      1,
      [run("the proband’s c.1234‐5A>G", 0, 500, 200)],
      viewport,
    );
    expect(index.text).toBe("the proband's c.1234-5A>G");
    expect(index.text.length).toBe("the proband’s c.1234‐5A>G".length);
    expect(normaliseChars("“quoted” minus−")).toBe('"quoted" minus-');
  });
});

describe("searchIndex", () => {
  const page = buildPageIndex(
    2,
    [
      run("The proband carried", 100, 900, 190, 10, true),
      run("the variant; the proband's", 100, 880, 260),
    ],
    viewport,
  );

  it("places a match inside a run proportionally along its advance and over the glyph box", () => {
    const { hits } = searchIndex([page], "proband");
    expect(hits[0]!.page).toBe(2);
    // "proband" is characters 4–11 of a 19-character run 190 wide starting
    // at x=100: left = 100 + 190·4/19, right = 100 + 190·11/19. Without
    // font metrics the box runs from 0.2 em below the baseline (y=900) to
    // 0.8 em above it, so on the flipped viewport from 92 to 102.
    expect(hits[0]!.bboxes).toEqual([
      { page: 2, left: 140, right: 210, top: 92, bottom: 102 },
    ]);
  });

  it("uses the font's own ascent and descent when the content carries them", () => {
    const styled = buildPageIndex(
      3,
      [run("proband", 100, 900, 70, 10, false, "f1")],
      viewport,
      { f1: { ascent: 1.0, descent: -0.3 } },
    );
    const { hits } = searchIndex([styled], "proband");
    expect(hits[0]!.bboxes[0]).toMatchObject({ top: 90, bottom: 103 });
  });

  it("gives a vertical run its whole box, hanging down from its origin", () => {
    // pdf.js records the em size in `width` and the downward advance in
    // `height` for a vertical run, with the origin centred on the column.
    const vertical = buildPageIndex(
      3,
      [run("縦書き", 100, 900, 10, 60, false, "v")],
      viewport,
      { v: { vertical: true } },
    );
    const { hits } = searchIndex([vertical], "書");
    expect(hits[0]!.bboxes[0]).toEqual({
      page: 3,
      left: 95,
      right: 105,
      top: 100,
      bottom: 160,
    });
  });

  it("falls back to the default metrics for a font reporting none, NaN or zero", () => {
    const boxFor = (style: object) =>
      searchIndex(
        [
          buildPageIndex(
            1,
            [run("proband", 100, 900, 70, 10, false, "f")],
            viewport,
            {
              f: style,
            },
          ),
        ],
        "proband",
      ).hits[0]!.bboxes[0]!;
    const defaults = { top: 92, bottom: 102 };
    expect(boxFor({})).toMatchObject(defaults);
    expect(boxFor({ ascent: Number.NaN, descent: Number.NaN })).toMatchObject(
      defaults,
    );
    expect(boxFor({ ascent: 0, descent: 0 })).toMatchObject(defaults);
    // Extremes are clamped so one line's box cannot swallow the next.
    expect(boxFor({ ascent: 3, descent: -2 })).toMatchObject({
      top: 88,
      bottom: 105,
    });
    // A descent written with the wrong sign is treated as missing.
    expect(boxFor({ ascent: 0.9, descent: 0.2 })).toMatchObject({
      top: 91,
      bottom: 102,
    });
  });

  it("matches a word hyphenated across a line break", () => {
    const broken = buildPageIndex(
      6,
      [
        run("the hetero-", 100, 900, 110, 10, true),
        run("zygous proband", 100, 880, 140),
      ],
      viewport,
    );
    const { hits } = searchIndex([broken], "heterozygous");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.bboxes).toHaveLength(2);
    expect(searchIndex([broken], "hetero-zygous").hits).toHaveLength(0);
  });

  it("folds dashes to a hyphen so a range typed with one is found", () => {
    const range = buildPageIndex(7, [run("c.123–456", 0, 500, 90)], viewport);
    expect(searchIndex([range], "c.123-456").hits).toHaveLength(1);
    const emDash = buildPageIndex(
      8,
      [run("loss\u2014of\u2014function", 0, 500, 90)],
      viewport,
    );
    expect(searchIndex([emDash], "loss-of-function").hits).toHaveLength(1);
  });

  it("finds every occurrence, case-insensitively, in reading order", () => {
    const { hits } = searchIndex([page], "PROBAND");
    expect(hits.map((h) => [h.start, h.end])).toEqual([
      [4, 11],
      [37, 44],
    ]);
  });

  it("matches across a line break and returns one box per run touched", () => {
    const { hits } = searchIndex([page], "carried the");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.bboxes).toHaveLength(2);
    expect(hits[0]!.bboxes.map((b) => b.top)).toEqual([92, 112]);
  });

  it("treats any whitespace in the query as any whitespace in the text", () => {
    expect(searchIndex([page], "carried   the").hits).toHaveLength(1);
    expect(searchIndex([page], " variant;  the ").hits).toHaveLength(1);
  });

  it("matches a straight apostrophe in the query against a curly one in the text", () => {
    const curly = buildPageIndex(4, [run("proband’s", 0, 500, 80)], viewport);
    expect(searchIndex([curly], "proband's").hits).toHaveLength(1);
    expect(searchIndex([curly], "proband’s").hits).toHaveLength(1);
  });

  it("escapes regular-expression syntax in the query", () => {
    expect(searchIndex([page], "variant;").hits).toHaveLength(1);
    expect(searchIndex([page], "proband's").hits).toHaveLength(1);
    expect(searchIndex([page], "pro.and").hits).toHaveLength(0);
  });

  it("stops at the limit and says so", () => {
    const many = buildPageIndex(
      5,
      [run("x".repeat(50), 0, 500, 500)],
      viewport,
    );
    const capped = searchIndex([many], "x", 20);
    expect(capped.hits).toHaveLength(20);
    expect(capped.capped).toBe(true);
    expect(searchIndex([many], "x").capped).toBe(false);
  });

  it("returns nothing for a blank query or no match", () => {
    expect(queryPattern("   ")).toBeNull();
    expect(searchIndex([page], "   ")).toEqual({ hits: [], capped: false });
    expect(searchIndex([page], "zebra").hits).toEqual([]);
  });
});

describe("buildDocumentIndex", () => {
  const doc = {
    numPages: 2,
    getPage: async (n: number) => ({
      getTextContent: async () => ({
        items: [run(`page ${n}`, 0, 500, 60, 10, false, "f")],
        styles: { f: { ascent: 0.9, descent: -0.1 } },
      }),
      getViewport: () => viewport,
    }),
  };

  it("indexes a page whose text cannot be read as empty and carries on", async () => {
    const flaky = {
      numPages: 3,
      getPage: async (n: number) => ({
        getTextContent: async () => {
          if (n === 2) throw new Error("corrupt font");
          return { items: [run(`page ${n}`, 0, 500, 60)] };
        },
        getViewport: () => viewport,
      }),
    };
    const pages = await buildDocumentIndex(flaky);
    expect(pages?.map((p) => [p.page, p.text])).toEqual([
      [1, "page 1"],
      [2, ""],
      [3, "page 3"],
    ]);
    expect(searchIndex(pages!, "page").hits.map((h) => h.page)).toEqual([1, 3]);
  });

  it("indexes every page in order, with the content's font metrics", async () => {
    const pages = await buildDocumentIndex(doc);
    expect(pages?.map((p) => [p.page, p.text])).toEqual([
      [1, "page 1"],
      [2, "page 2"],
    ]);
    expect(pages![0]!.runs[0]).toMatchObject({ ascent: 0.9, descent: -0.1 });
    expect(searchIndex(pages!, "page").hits.map((h) => h.page)).toEqual([1, 2]);
  });

  it("returns null once cancelled", async () => {
    let calls = 0;
    const pages = await buildDocumentIndex(doc, () => ++calls > 1);
    expect(pages).toBeNull();
  });
});
