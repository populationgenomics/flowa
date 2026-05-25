/** Line-numbered display and literal search over arbitrary text. */

/** Add 1-indexed line numbers to text for display. */
export function addLineNumbers(text: string): string {
  const lines = text.split("\n");
  const width = String(lines.length).length;
  return lines
    .map((line, i) => `${String(i + 1).padStart(width)}\t${line}`)
    .join("\n");
}

/**
 * Extract a line range and return with line numbers.
 * 1-indexed; end=-1 means end of file; start is clamped to 1.
 */
export function viewLineRange(
  text: string,
  start: number,
  end: number,
): string {
  const lines = text.split("\n");
  const s = Math.max(1, start);
  const e = end === -1 ? lines.length : Math.min(end, lines.length);
  const width = String(e).length;
  return lines
    .slice(s - 1, e)
    .map((line, i) => `${String(s + i).padStart(width)}\t${line}`)
    .join("\n");
}

/**
 * Find lines containing a literal substring. Returns matches with one line
 * of context either side; adjacent or overlapping context blocks merge,
 * non-adjacent blocks are separated by "--". A line with multiple substring
 * occurrences counts as one match.
 */
export function searchLines(
  text: string,
  pattern: string,
): { output: string; count: number } {
  if (!pattern) return { output: "", count: 0 };
  const lines = text.split("\n");
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.includes(pattern)) hits.push(i);
  }
  if (hits.length === 0) return { output: "", count: 0 };

  const ranges: [number, number][] = [];
  for (const i of hits) {
    const start = Math.max(0, i - 1);
    const end = Math.min(lines.length - 1, i + 1);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }

  const width = String(lines.length).length;
  const blocks = ranges.map(([s, e]) =>
    lines
      .slice(s, e + 1)
      .map((line, i) => `${String(s + 1 + i).padStart(width)}\t${line}`)
      .join("\n"),
  );
  return { output: blocks.join("\n--\n"), count: hits.length };
}

/**
 * Like {@link viewLineRange}, but caps the returned slice at `maxChars`. If
 * the requested range fits, returns it unchanged. Otherwise, returns the
 * largest leading prefix that fits, followed by a notice line naming the
 * cut-off line and the upper bound of the request. The cap applies to the
 * returned slice, not to the underlying file.
 */
export function viewLineRangeCapped(
  text: string,
  start: number,
  end: number,
  maxChars = 100_000,
): string {
  const lines = text.split("\n");
  const s = Math.max(1, start);
  const e = end === -1 ? lines.length : Math.min(end, lines.length);
  const width = String(e).length;
  const numbered = lines
    .slice(s - 1, e)
    .map((line, i) => `${String(s + i).padStart(width)}\t${line}`);
  const fullOutput = numbered.join("\n");
  if (fullOutput.length <= maxChars) return fullOutput;

  const notice = (cutoff: number) =>
    `[Output truncated at line ${cutoff} of ${e} — request a narrower view_range or use searchPaper to locate specific passages.]`;

  // Reserve room for a maximally-sized notice (cutoff at most `e`). This
  // under-uses the cap by a handful of chars at the boundary but keeps the
  // loop simple — negligible against a 100K-char budget.
  const contentBudget = maxChars - notice(e).length - 1;

  let total = 0;
  let included = 0;
  for (let i = 0; i < numbered.length; i++) {
    const lineLen = numbered[i]!.length;
    const sep = i === 0 ? 0 : 1;
    if (total + sep + lineLen > contentBudget) break;
    total += sep + lineLen;
    included = i + 1;
  }

  if (included === 0) {
    // First numbered line doesn't fit beside the notice. Return the notice
    // alone, attributing the cut to the line before the requested range.
    return notice(s - 1);
  }

  const cutoffLine = s + included - 1;
  return `${numbered.slice(0, included).join("\n")}\n${notice(cutoffLine)}`;
}
