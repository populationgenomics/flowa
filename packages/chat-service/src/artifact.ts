// Citation-grounded artifact core. chat-service hardcodes a small fixed
// set of fields (`category`, `description`, `notes`, `papers`, `claims`)
// because those are what the chat-tool design — `view`, `search`,
// `str_replace`, `insert`, `write` over a citation-grounded synthesis —
// actually depends on. Deployments extend by calling
// `ArtifactSchema.extend({...})` with their additional fields; they do
// not rename the core fields.
//
// Field names mirror flowa's `prompts/generic/aggregation_schema.py`.

import { z } from "zod";

const CitationBbox = z.object({
  page: z.number().describe("Page number in the source document."),
  top: z.number().describe("Top edge of the highlight rectangle."),
  left: z.number().describe("Left edge of the highlight rectangle."),
  bottom: z.number().describe("Bottom edge of the highlight rectangle."),
  right: z.number().describe("Right edge of the highlight rectangle."),
});

const CitationMarkdownAnchor = z.object({
  start: z
    .number()
    .describe("Start offset (Unicode code point) of the quote in markdown.md."),
  end: z
    .number()
    .describe(
      "End offset (exclusive, Unicode code point) of the quote in markdown.md.",
    ),
});

const CitationLocation = z.object({
  bboxes: z
    .array(CitationBbox)
    .describe(
      "PDF highlight rectangles for the quote; empty when it wasn't aligned in the source PDF.",
    ),
  markdown_anchor: CitationMarkdownAnchor.nullable().describe(
    "Half-open [start, end) code-point range of the quote in markdown.md; null when it wasn't located there.",
  ),
});

const ArtifactCitation = z.object({
  quote: z
    .string()
    .describe(
      "Verbatim passage from the source document. Must be copied exactly — enough context to validate the claim.",
    ),
  location: CitationLocation.nullish().describe(
    "Pre-computed resolution of the quote: where it lives in the source PDF (bboxes) and the assembled markdown.md (anchor). Present on pipeline-generated citations (possibly with empty bboxes / null anchor); absent on citations added during editing.",
  ),
});

const ArtifactClaim = z.object({
  paper_id: z
    .string()
    .describe(
      "Identifier of the source document. Must appear in the papers[] list.",
    ),
  text: z
    .string()
    .describe(
      "The factual statement supported by the source document. One atomic fact per claim.",
    ),
  citations: z
    .array(ArtifactCitation)
    .min(1)
    .describe(
      "One or more supporting verbatim quotes from the document identified by paper_id.",
    ),
});

const RankedPaper = z.object({
  paper_id: z.string().describe("Identifier of the source document."),
  rank_rationale: z
    .string()
    .describe(
      "One sentence explaining why this document sits at this rank in the synthesis.",
    ),
});

/**
 * Citation-grounded fields shared by every chat-service artifact. Deployments
 * extend the schema by calling `ArtifactSchema.extend({...})` with their
 * additional fields:
 *
 * ```ts
 * import { ArtifactSchema } from "@flowajs/chat-service";
 *
 * export const MyArtifactSchema = ArtifactSchema.extend({
 *   classification: z.string(),
 *   classification_rationale: z.string(),
 * });
 * ```
 *
 * `.extend(...)` preserves the shape's TypeScript type, so the resulting
 * schema stays assignable to `z.ZodType<Artifact>` at the
 * `createApp({ schema })` call site. Spreading `...artifactFields` into a
 * fresh `z.object({...})` works at runtime but widens the inferred shape
 * to `Record<string, any>`, which fails the static type. `artifactFields`
 * is exported anyway for runtime inspection / reflection.
 *
 * Deployments must keep these fields with these names; chat-service reads
 * them directly. Refining their types (e.g. constraining `category` to a
 * Zod enum) is fine; renaming is not.
 */
export const artifactFields = {
  category: z
    .string()
    .describe(
      "Selector identifying which result this artifact represents within its aggregate. Mirrors aggregation.results[].category in flowa's prompts/generic/aggregation_schema.py.",
    ),
  description: z
    .string()
    .describe("Short human-readable summary of the synthesis."),
  notes: z
    .string()
    .describe(
      'Long-form synthesis in Markdown. Uses inline citation links: [text](#cite:paper_id "verbatim quote").',
    ),
  papers: z
    .array(RankedPaper)
    .describe(
      "Source documents contributing to the synthesis, ordered by contribution. List position is the rank. paper_id values must be unique.",
    ),
  claims: z
    .array(ArtifactClaim)
    .describe(
      "Factual claims supporting the synthesis. Grouped by paper_id in the same order as papers[].",
    ),
} as const;

/**
 * The minimal Zod schema chat-service can operate on. Any plugin's schema is
 * a superset: it spreads `artifactFields` and adds deployment fields.
 */
export const ArtifactSchema = z.object(artifactFields);

/**
 * The citation-grounded artifact type. Deployments may name their own
 * extended type; this is the base chat-service operates on.
 */
export type Artifact = z.infer<typeof ArtifactSchema>;

/**
 * Render a Zod schema as a JSON Schema string for inclusion in the system
 * prompt. The descriptions on each field serve as documentation.
 */
export function schemaForPrompt(schema: z.ZodType): string {
  return JSON.stringify(z.toJSONSchema(schema), null, 2);
}
