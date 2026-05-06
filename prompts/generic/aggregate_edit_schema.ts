/**
 * Generic aggregate-edit artifact schema for flowa's `prompts/generic/` set.
 *
 * Mirrors `prompts/generic/aggregate_schema.py:CategoryResult`: the
 * citation-grounded core fields exposed by `@flowajs/chat-service`'s
 * `artifactFields`, plus `classification` and `classification_rationale`
 * for ACMG-style variant assessment.
 *
 * Deployments wanting different fields should write their own schema
 * following the same pattern: spread `artifactFields`, add deployment
 * fields. Keep core field names with these names; chat-service reads them
 * directly. Refining types (e.g. constraining `classification` to a Zod
 * enum) is fine; renaming is not.
 *
 * Loaded at compile time by deployment entries (e.g. `examples/demo/`)
 * that pass it to `createApp({ schema })`. Not consumed at runtime by
 * `@flowajs/chat-service` itself.
 */

import { artifactFields } from "@flowajs/chat-service";
import { z } from "zod";

export const ArtifactSchema = z.object({
  ...artifactFields,
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
