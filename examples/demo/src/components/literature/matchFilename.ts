/**
 * Map an uploaded file's name to a known paper.
 *
 * The bulk dropzone tolerates two filename conventions:
 *   - `<PMID>.pdf`            — a positive-integer PubMed identifier
 *   - `<encoded-DOI>.pdf`     — RFC 3986 strict-encoded DOI (matches the
 *                                on-disk dir name `papers/{encodedDoi}/`)
 *
 * No title alignment, no fuzzy matching, no confirm dialog. The curator
 * is responsible for naming the files correctly. Anything that doesn't
 * match exactly stays unmatched and gets surfaced as a "could not match"
 * row in the dropzone summary.
 */

import type { PaperRow } from "@/lib/papers";

const PDF_SUFFIX_RE = /\.pdf$/i;
const PMID_RE = /^[0-9]+$/;

export interface MatchResult {
  file: File;
  paper: PaperRow | null;
}

export function stripPdfSuffix(filename: string): string {
  return filename.replace(PDF_SUFFIX_RE, "");
}

export function matchFilename(
  filename: string,
  papers: PaperRow[],
): PaperRow | null {
  const stem = stripPdfSuffix(filename);
  if (stem.length === 0 || stem === filename) {
    // Either the original is empty or there's no `.pdf` suffix to strip.
    return null;
  }

  if (PMID_RE.test(stem)) {
    const pmid = Number.parseInt(stem, 10);
    return papers.find((p) => p.pmid === pmid) ?? null;
  }
  return papers.find((p) => p.encodedDoi === stem) ?? null;
}

export function matchFiles(files: File[], papers: PaperRow[]): MatchResult[] {
  return files.map((file) => ({
    file,
    paper: matchFilename(file.name, papers),
  }));
}
