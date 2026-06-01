import { SKIP, visit } from "unist-util-visit";
import type { Element, Root as HastRoot, Text } from "hast";
import type { Heading, Root as MdastRoot } from "mdast";
import type { Utf16Anchor } from "./types";

/** CSS class on the injected highlight `<mark>`; also the scroll-into-view hook. */
export const ANCHOR_MARK_CLASS = "anchor-highlight";

/** CSS class on an injected "from <supplement>" divider heading. */
export const SUPPLEMENT_HEADING_CLASS = "supplement-source-heading";

const SUPPLEMENT_MARKER_RE = /^<!--\s*supplement:\s*(.+?)\s*-->$/;

/**
 * Strip the `NNN_` ordinal prefix the pipeline prepends to stored supplement
 * filenames (e.g. `000_table_s1.docx` → `table_s1.docx`).
 */
export function prettifySupplementName(filename: string): string {
  return filename.replace(/^\d+_/, "");
}

/**
 * remark plugin: turn the pipeline's `<!--supplement: NNN_name-->` HTML-comment
 * markers (written by `flowa.assemble` between `source.md` and each appended
 * supplement) into visible `### from <name>` divider headings.
 *
 * Without this, react-markdown drops the comments (we deliberately don't enable
 * `rehype-raw`) and supplement content runs on with no divider. The injected
 * heading is created *without* a `position`, so {@link rehypeAnchorMark} skips
 * it — its "from <name>" text isn't part of the source content stream the anchor
 * offsets index into. Replacing one node with one node leaves every other node's
 * `position` (and therefore every anchor offset) untouched.
 */
export function remarkSupplementMarkers() {
  return (tree: MdastRoot) => {
    visit(tree, "html", (node, index, parent) => {
      if (index === undefined || !parent) return;
      const match = SUPPLEMENT_MARKER_RE.exec(node.value.trim());
      if (!match) return;
      const heading: Heading = {
        type: "heading",
        depth: 3,
        children: [
          { type: "text", value: `from ${prettifySupplementName(match[1]!)}` },
        ],
        data: { hProperties: { className: [SUPPLEMENT_HEADING_CLASS] } },
      };
      parent.children[index] = heading;
    });
  };
}

export interface AnchorMarkOptions {
  anchor: Utf16Anchor | null | undefined;
}

/**
 * rehype plugin: wrap the text covered by `anchor` (UTF-16 offsets into the
 * source markdown) in `<mark class="anchor-highlight">`, splitting text nodes at
 * the range boundaries.
 *
 * It walks hast text nodes and, for each whose source `position` overlaps the
 * anchor, wraps just the overlapping slice. Because it acts per text node, an
 * anchor that spans several table cells (the common case for converted Excel/
 * Word supplements) yields one `<mark>` per cell and leaves the table structure
 * intact — unlike splicing `<mark>` into the Markdown string, which would break
 * the table across cell delimiters.
 *
 * Requires a {@link Utf16Anchor}: hast `position.offset` is UTF-16, so the anchor
 * must already be converted from code points (see `codePointAnchorToUtf16`).
 */
export function rehypeAnchorMark(options: AnchorMarkOptions) {
  const anchor = options.anchor;
  return (tree: HastRoot) => {
    if (!anchor || anchor.end <= anchor.start) return;
    visit(tree, "text", (node: Text, index, parent) => {
      if (index === undefined || !parent) return;
      const pos = node.position;
      // Nodes without source offsets (e.g. our injected supplement headings)
      // aren't part of the offset-indexed content — leave them alone.
      if (pos?.start.offset === undefined || pos.end.offset === undefined) {
        return;
      }
      const nodeStart = pos.start.offset;
      const lo = Math.max(anchor.start, nodeStart);
      const hi = Math.min(anchor.end, pos.end.offset);
      if (lo >= hi) return;

      const value = node.value;
      // Value index = source offset − node start. 1:1 with UTF-16 units for
      // plain text; clamping guards the rare node whose decoded length differs
      // from its source span (HTML entities / backslash escapes).
      const a = Math.max(0, Math.min(lo - nodeStart, value.length));
      const b = Math.max(0, Math.min(hi - nodeStart, value.length));
      if (a >= b) return;

      const mark: Element = {
        type: "element",
        tagName: "mark",
        properties: { className: [ANCHOR_MARK_CLASS] },
        children: [{ type: "text", value: value.slice(a, b) }],
      };
      const replacement: Array<Text | Element> = [];
      if (a > 0) replacement.push({ type: "text", value: value.slice(0, a) });
      replacement.push(mark);
      if (b < value.length) {
        replacement.push({ type: "text", value: value.slice(b) });
      }
      parent.children.splice(index, 1, ...replacement);
      // Resume past the inserted nodes (their text children carry no position
      // and would be skipped anyway, but this avoids the rework).
      return [SKIP, index + replacement.length];
    });
  };
}
