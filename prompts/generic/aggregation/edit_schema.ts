/**
 * Generic aggregation-edit artifact schema for flowa's `prompts/generic/` set.
 *
 * Mirrors `prompts/generic/aggregation_schema.py:CategoryResult`: the
 * citation-grounded core fields exposed by `@flowajs/chat-service`'s
 * `ArtifactSchema`, plus `classification` and `classification_rationale`
 * for ACMG-style variant assessment.
 *
 * Deployments wanting different fields should write their own schema
 * following the same pattern: take `ArtifactSchema` (the citation-grounded
 * core) and `.extend(...)` with deployment fields. Keep core field names
 * with these names; chat-service reads them directly. Refining types (e.g.
 * constraining `classification` to a Zod enum) is fine; renaming is not.
 *
 * `.extend(...)` is used instead of spreading `artifactFields` because
 * spreading widens the shape's TypeScript type to a generic record, which
 * makes the resulting schema unassignable to `z.ZodType<Artifact>` at the
 * `createApp({ schema })` call site. `.extend(...)` preserves the shape,
 * so the deployment's broader schema is assignable to the narrower
 * core-only parameter type.
 *
 * Loaded at compile time by deployment entries that pass it to
 * `createApp({ schema })`. Not consumed at runtime by `@flowajs/chat-service`
 * itself.
 */

import { ArtifactSchema as CoreSchema } from "@flowajs/chat-service";
import { z } from "zod";

export const ArtifactSchema = CoreSchema.extend({
  classification: z
    .string()
    .describe(
      "ACMG classification term: Pathogenic, Likely Pathogenic, VUS, Likely Benign, or Benign.",
    ),
  classification_rationale: z
    .string()
    .describe(
      "One short clause naming the deciding factor for this classification (e.g. evidence type, expert panel result, or nature of conflict). Detailed reasoning belongs in `notes`.",
    ),
});

export type Artifact = z.infer<typeof ArtifactSchema>;
