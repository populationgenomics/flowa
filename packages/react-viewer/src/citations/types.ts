/** Paper-id mapping entry. `pmid` is optional. */
export interface PaperIdEntry {
  doi: string;
  pmid?: number;
}

/**
 * Bidirectional mapping between {AuthorYear} citation labels and paper
 * identifiers. Produced by the aggregate stage of the flowa pipeline; the
 * pipeline guarantees `byAuthorYear` and `byDoi` are mutual inverses.
 */
export interface PaperIdMapping {
  /** {AuthorYear} → paper identity (doi + optional pmid). */
  byAuthorYear: Record<string, PaperIdEntry>;
  /** DOI → {AuthorYear} label. */
  byDoi: Record<string, string>;
}
