/**
 * Variant identifier derivation + validation.
 *
 * The demo's submission flow takes a free-text gene symbol and HGVS-c
 * notation from the user and derives a filesystem-safe `variant_id` that
 * encodes both. The same shape is used for the storage key
 * (`assessments/{variant_id}/...`) and URL segments
 * (`/variants/[variantId]`, `/api/runs/[variantId]/...`), so the derived
 * id must restrict itself to a path-safe alphabet and must round-trip
 * deterministically (resubmitting the same gene + hgvs_c produces the
 * same id, so a re-analyze idempotently maps back to the same
 * assessment dir).
 *
 * Mirrors what curation-service does at the assessment layer: the
 * variant identity is fully derived from the inputs by the trusted
 * server, never carried in the browser-submitted body.
 */

/** Path-safe charset: the slug + dash joiner. */
export const VARIANT_ID_RE = /^[A-Za-z0-9_-]+$/;

export function isValidVariantId(s: string): boolean {
  return VARIANT_ID_RE.test(s);
}

/**
 * Collapse non-alphanumerics in a single HGVS notation fragment to `_`.
 * Conservative: keeps letters/digits/underscore as-is, replaces anything
 * else (`.`, `:`, `>`, `(`, `)`, etc.) with `_`. Empty input is kept as
 * the empty string so the caller can decide whether that's valid.
 */
export function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, "_");
}

/**
 * Derive `variant_id` from a gene symbol and HGVS c. notation.
 *
 * - When `hgvs_c` carries a transcript prefix (`NM_001035.3:c.14174A>G`),
 *   the colon is split out and the transcript + change are slugged
 *   independently so transcript versions don't collide
 *   (`NM_001035.3` vs `NM_001035.2` produce distinct ids).
 * - Without a transcript prefix (`c.14174A>G`), the whole string is
 *   slugged in one go.
 *
 * Examples:
 *   deriveVariantId("RYR2", "NM_001035.3:c.14174A>G")
 *     → "RYR2-NM_001035_3-c_14174A_G"
 *   deriveVariantId("RYR2", "c.14174A>G")
 *     → "RYR2-c_14174A_G"
 */
export function deriveVariantId(gene: string, hgvs_c: string): string {
  const colon = hgvs_c.indexOf(":");
  if (colon === -1) {
    return `${gene}-${slug(hgvs_c)}`;
  }
  const transcript = hgvs_c.slice(0, colon);
  const change = hgvs_c.slice(colon + 1);
  return `${gene}-${slug(transcript)}-${slug(change)}`;
}
