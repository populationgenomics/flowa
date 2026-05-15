import { describe, expect, test } from "vitest";
import {
  matchFilename,
  matchFiles,
  stripPdfSuffix,
} from "../src/components/literature/matchFilename";
import type { PaperRow } from "../src/lib/papers";

function row(overrides: Partial<PaperRow> = {}): PaperRow {
  return {
    doi: "10.1371/journal.pone.0131517",
    encodedDoi: "10.1371%2Fjournal.pone.0131517",
    status: "needs_manual",
    title: "test",
    authors: "Ohno, S",
    pmid: 26114861,
    url: "https://doi.org/10.1371/journal.pone.0131517",
    ...overrides,
  };
}

describe("stripPdfSuffix", () => {
  test("strips lowercase .pdf", () => {
    expect(stripPdfSuffix("foo.pdf")).toBe("foo");
  });

  test("strips uppercase .PDF", () => {
    expect(stripPdfSuffix("foo.PDF")).toBe("foo");
  });

  test("leaves non-pdf names alone", () => {
    expect(stripPdfSuffix("foo.txt")).toBe("foo.txt");
  });
});

describe("matchFilename", () => {
  test("matches by PMID stem", () => {
    const papers = [row()];
    expect(matchFilename("26114861.pdf", papers)).toBe(papers[0]);
  });

  test("matches by encoded-DOI stem", () => {
    const papers = [row()];
    expect(matchFilename("10.1371%2Fjournal.pone.0131517.pdf", papers)).toBe(
      papers[0],
    );
  });

  test("returns null when no .pdf suffix", () => {
    const papers = [row()];
    expect(matchFilename("26114861", papers)).toBeNull();
  });

  test("returns null when stem matches no paper", () => {
    const papers = [row()];
    expect(matchFilename("99999999.pdf", papers)).toBeNull();
  });

  test("ignores papers with null pmid when stem is numeric", () => {
    const papers = [row({ pmid: null })];
    expect(matchFilename("26114861.pdf", papers)).toBeNull();
  });

  test("PMID match takes precedence over a DOI containing the same digits", () => {
    const papers = [
      row({
        pmid: 26114861,
        encodedDoi: "fake",
      }),
      row({
        pmid: null,
        doi: "1234/26114861",
        encodedDoi: "1234%2F26114861",
      }),
    ];
    expect(matchFilename("26114861.pdf", papers)).toBe(papers[0]);
  });

  test("rejects empty stem", () => {
    const papers = [row()];
    expect(matchFilename(".pdf", papers)).toBeNull();
  });

  test("treats unrelated extensions as a non-match", () => {
    const papers = [row()];
    expect(matchFilename("26114861.txt", papers)).toBeNull();
  });
});

describe("matchFiles", () => {
  test("preserves order and includes unmatched entries", () => {
    const papers = [row()];
    const files = [
      new File([""], "26114861.pdf"),
      new File([""], "unknown.pdf"),
    ];
    const out = matchFiles(files, papers);
    expect(out).toHaveLength(2);
    expect(out[0]!.paper).toBe(papers[0]);
    expect(out[1]!.paper).toBeNull();
  });
});
