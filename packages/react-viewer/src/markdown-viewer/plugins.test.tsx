// @vitest-environment happy-dom

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ANCHOR_MARK_CLASS,
  SUPPLEMENT_HEADING_CLASS,
  prettifySupplementName,
  rehypeAnchorMark,
  remarkStripComments,
  remarkSupplementMarkers,
} from "./plugins";
import { codePointAnchorToUtf16 } from "./offsets";
import type { Utf16Anchor } from "./types";

function renderMd(md: string, anchor: Utf16Anchor | null) {
  return render(
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkSupplementMarkers, remarkStripComments]}
      rehypePlugins={anchor ? [[rehypeAnchorMark, { anchor }]] : []}
    >
      {md}
    </ReactMarkdown>,
  );
}

/** Build the anchor the way the viewer does: code-point offsets → UTF-16.
 *  Test strings are all-BMP, so `indexOf` (UTF-16) doubles as the code-point
 *  offset, and the conversion also mints the branded Utf16Anchor. */
function anchorFor(md: string, needle: string): Utf16Anchor {
  const start = md.indexOf(needle);
  return codePointAnchorToUtf16(md, { start, end: start + needle.length });
}

describe("prettifySupplementName", () => {
  it("strips the NNN_ ordinal prefix", () => {
    expect(prettifySupplementName("000_table_s1.docx")).toBe("table_s1.docx");
    expect(prettifySupplementName("012_Patient Data.xlsx")).toBe(
      "Patient Data.xlsx",
    );
    expect(prettifySupplementName("no_prefix.docx")).toBe("no_prefix.docx");
  });
});

describe("rehypeAnchorMark", () => {
  it("wraps a prose span in a single <mark>", () => {
    const md = "The variant p.Arg175His is pathogenic.";
    const { container } = renderMd(md, anchorFor(md, "p.Arg175His"));
    const marks = container.querySelectorAll(`mark.${ANCHOR_MARK_CLASS}`);
    expect(marks).toHaveLength(1);
    expect(marks[0]!.textContent).toBe("p.Arg175His");
  });

  it("renders no mark when there is no anchor", () => {
    const { container } = renderMd("Plain text.", null);
    expect(container.querySelector("mark")).toBeNull();
  });

  it("highlights a quote that spans table cells without breaking the table", () => {
    const md = [
      "| Variant | Call |",
      "|---|---|",
      "| p.Arg175His | Pathogenic |",
    ].join("\n");
    // The quote covers "p.Arg175His | Pathogenic" — across the cell delimiter.
    const start = md.indexOf("p.Arg175His");
    const end = md.indexOf("Pathogenic") + "Pathogenic".length;
    const anchor = codePointAnchorToUtf16(md, { start, end });
    const { container } = renderMd(md, anchor);

    // The table structure survives.
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelectorAll("td")).toHaveLength(2);

    // One <mark> per overlapping cell, each inside its own <td>.
    const marks = [...container.querySelectorAll(`mark.${ANCHOR_MARK_CLASS}`)];
    expect(marks.map((m) => m.textContent?.trim())).toEqual([
      "p.Arg175His",
      "Pathogenic",
    ]);
    marks.forEach((m) => expect(m.closest("td")).not.toBeNull());
  });
});

describe("remarkSupplementMarkers", () => {
  it("turns a supplement marker into a 'from <name>' heading", () => {
    const md = [
      "Main text.",
      "",
      "<!--supplement: 000_table_s1.docx-->",
      "",
      "| X | Y |",
      "|---|---|",
      "| 1 | 2 |",
    ].join("\n");
    const { container } = renderMd(md, null);

    const heading = [...container.querySelectorAll("h3")].find(
      (h) => h.textContent === "from table_s1.docx",
    );
    expect(heading).toBeDefined();
    expect(heading!.className).toContain(SUPPLEMENT_HEADING_CLASS);
    // The raw comment is gone, not shown literally.
    expect(container.textContent).not.toContain("supplement:");
    expect(container.textContent).not.toContain("<!--");
  });
});

describe("remarkStripComments", () => {
  it("hides page/table/figure/end markers instead of leaking them as text", () => {
    const md = [
      "Intro.",
      "",
      "<!--page-->",
      "",
      "<!--table: 2-->",
      "",
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "<!--end-->",
      "",
      "<!--figure: 1-->",
      "",
      "A caption.",
      "",
      "<!--end-->",
      "",
      "Outro.",
    ].join("\n");
    const { container } = renderMd(md, null);

    // No structural comment leaks (react-markdown would otherwise escape and
    // show them as literal `<!--…-->` text).
    expect(container.textContent).not.toContain("<!--");
    expect(container.textContent).not.toContain("table:");
    expect(container.textContent).not.toContain("figure:");
    // Real content (including the table) still renders.
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.textContent).toContain("Intro.");
    expect(container.textContent).toContain("A caption.");
    expect(container.textContent).toContain("Outro.");
  });

  it("leaves supplement headings intact (strip runs after the transform)", () => {
    const md = [
      "Main text.",
      "",
      "<!--supplement: 000_t.docx-->",
      "",
      "Supp body.",
    ].join("\n");
    const { container } = renderMd(md, null);

    expect(
      [...container.querySelectorAll("h3")].some(
        (h) => h.textContent === "from t.docx",
      ),
    ).toBe(true);
    expect(container.textContent).not.toContain("<!--");
  });

  it("removing a marker leaves anchor offsets intact", () => {
    // Removing the comment node doesn't shift other nodes' source offsets, so a
    // quote past the marker still resolves.
    const md = [
      "First.",
      "",
      "<!--page-->",
      "",
      "The variant p.Arg175His is here.",
    ].join("\n");
    const { container } = renderMd(md, anchorFor(md, "p.Arg175His"));

    const marks = container.querySelectorAll(`mark.${ANCHOR_MARK_CLASS}`);
    expect(marks).toHaveLength(1);
    expect(marks[0]!.textContent).toBe("p.Arg175His");
  });
});

describe("supplement marker + anchor together", () => {
  it("highlights inside a supplement table; the injected heading doesn't desync offsets", () => {
    const md = [
      "Intro paragraph.",
      "",
      "<!--supplement: 000_data.docx-->",
      "",
      "| Gene | Variant |",
      "|---|---|",
      "| GAA | c.1935C>A |",
    ].join("\n");
    const anchor = anchorFor(md, "c.1935C>A");
    const { container } = renderMd(md, anchor);

    // The divider heading is present…
    expect(
      [...container.querySelectorAll("h3")].some(
        (h) => h.textContent === "from data.docx",
      ),
    ).toBe(true);
    // …and the anchor still lands on the right cell text despite the injected
    // heading sitting between the marker and the table.
    const marks = container.querySelectorAll(`mark.${ANCHOR_MARK_CLASS}`);
    expect(marks).toHaveLength(1);
    expect(marks[0]!.textContent).toBe("c.1935C>A");
    expect(marks[0]!.closest("td")).not.toBeNull();
  });
});
