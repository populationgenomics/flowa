/**
 * Variant identifier derivation + validation.
 *
 * The demo's submission flow takes a RefSeq transcript and a c.-form
 * HGVS expression (as two free-text fields) from the user and derives a
 * filesystem-safe `variant_id` that encodes both. The same shape is
 * used for the storage key (`assessments/{variant_id}/...`) and URL
 * segments (`/variants/[variantId]`, `/api/runs/[variantId]/...`), so
 * the derived id must restrict itself to a path-safe alphabet and must
 * round-trip deterministically (resubmitting the same transcript +
 * hgvs_c produces the same id, so a re-analyze idempotently maps back
 * to the same assessment dir).
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
 * Derive `variant_id` from a transcript + c.-form HGVS expression.
 *
 * Each part is slugged independently and joined with `-`, so transcript
 * versions don't collide (`NM_001035.3` vs `NM_001035.2` produce
 * distinct ids).
 *
 * Example:
 *   deriveVariantId("NM_001035.3", "c.14174A>G")
 *     → "NM_001035_3-c_14174A_G"
 */
export function deriveVariantId(transcript: string, hgvs_c: string): string {
  return `${slug(transcript)}-${slug(hgvs_c)}`;
}
