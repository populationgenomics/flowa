/**
 * Match uploaded files to papers by filename alone.
 *
 * Two filename conventions are recognised, both keyed on a leading identifier
 * that is either a PubMed id or an RFC 3986 strict-encoded DOI (the same string
 * `encodeDoi` produces, i.e. the on-disk `papers/{encodedDoi}/` directory name):
 *
 *   - a *main* paper PDF: `<id>.pdf`
 *   - a *supplement*:     `<id>[_ ]supp…`  (id, an underscore or space, then
 *                          `supp` — covering supp / suppl / supplementary / …),
 *                          any extension. A supplement attaches to the paper its
 *                          `<id>` resolves to and is excluded from main matching.
 *
 * Matching is purely by filename: no PDF-content inspection and no cross-file
 * (sibling) inference. A consumer that also content-matches arbitrarily named
 * PDFs, or links a supplement to a sibling main that only content-matched, layers
 * that on top of the returned `unmatched` list.
 */

import { encodeDoi } from "../triage/citation-utils";

/** The minimal paper shape the filename matcher resolves against. */
export interface MatchablePaper {
  doi: string;
  pmid?: number | null;
}

/** A file paired with the paper it resolved to. */
export interface FileMatch<P> {
  filename: string;
  paper: P;
}

export interface MatchFilesResult<P> {
  /** `<id>.pdf` files whose stem resolved to a paper (first file wins per paper). */
  mains: FileMatch<P>[];
  /** `<id>[_ ]supp…` files whose `<id>` resolved to a paper, sorted lexicographically. */
  supplements: FileMatch<P>[];
  /** Files that resolved to no paper (unrecognised mains, or supplements whose id matched nothing). */
  unmatched: string[];
}

const PDF_SUFFIX_RE = /\.pdf$/i;
// `<pmid>` optionally prefixed with `PMID`, `PMID_`, `PMID-`, or `PMID ` (any case).
const PMID_RE = /^(?:PMID[_\s-]?)?(\d+)$/i;
// `<id>` followed by an underscore or space, then `supp`. The non-greedy `<id>`
// captures the shortest leading run, so the first `[_ ]supp` token delimits it.
const SUPPLEMENT_RE = /^(.+?)[ _]supp/i;

/**
 * If `filename` follows the supplement convention `<id>[_ ]supp…`, return the
 * leading `<id>` that identifies its paper; otherwise return null. This is the
 * single definition of "is this a supplement filename".
 */
export function parseSupplementFilename(filename: string): string | null {
  const match = SUPPLEMENT_RE.exec(filename);
  return match ? match[1]! : null;
}

function resolvePaper<P extends MatchablePaper>(
  id: string,
  pmidToPaper: Map<number, P>,
  encodedDoiToPaper: Map<string, P>,
): P | null {
  const pmidMatch = PMID_RE.exec(id);
  if (pmidMatch) {
    const paper = pmidToPaper.get(Number.parseInt(pmidMatch[1]!, 10));
    if (paper) return paper;
  }
  return encodedDoiToPaper.get(id) ?? null;
}

export function matchFilesToPapers<P extends MatchablePaper>(
  filenames: string[],
  papers: P[],
): MatchFilesResult<P> {
  const pmidToPaper = new Map<number, P>();
  const encodedDoiToPaper = new Map<string, P>();
  for (const paper of papers) {
    if (paper.pmid != null) pmidToPaper.set(paper.pmid, paper);
    encodedDoiToPaper.set(encodeDoi(paper.doi), paper);
  }

  const mains: FileMatch<P>[] = [];
  const supplements: FileMatch<P>[] = [];
  const unmatched: string[] = [];
  const matchedMainDois = new Set<string>();

  for (const filename of filenames) {
    const supplementId = parseSupplementFilename(filename);
    if (supplementId !== null) {
      const paper = resolvePaper(supplementId, pmidToPaper, encodedDoiToPaper);
      if (paper) supplements.push({ filename, paper });
      else unmatched.push(filename);
      continue;
    }

    // A main paper is a PDF named by its id; a non-PDF, non-supplement file
    // (or a bare id with no `.pdf`) is not a paper.
    if (!PDF_SUFFIX_RE.test(filename)) {
      unmatched.push(filename);
      continue;
    }
    const stem = filename.replace(PDF_SUFFIX_RE, "");
    const paper = resolvePaper(stem, pmidToPaper, encodedDoiToPaper);
    if (paper && !matchedMainDois.has(paper.doi)) {
      mains.push({ filename, paper });
      matchedMainDois.add(paper.doi);
    } else {
      unmatched.push(filename);
    }
  }

  // Lexicographic order gives a stable per-paper supplement sequence the caller
  // can turn into ingestion ordinals.
  supplements.sort((a, b) =>
    a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0,
  );

  return { mains, supplements, unmatched };
}
