/**
 * Public API surface for `@flowajs/chat-service`.
 *
 * Deployments compose their full artifact schema by calling
 * `ArtifactSchema.extend({ ... })` with their additional fields, then
 * pass the result to `createApp({ schema })` (from
 * `@flowajs/chat-service/server`). `.extend(...)` preserves the shape's
 * TypeScript type so the resulting schema stays assignable to
 * `z.ZodType<Artifact>`; spreading `...artifactFields` into a fresh
 * `z.object({...})` also works at runtime but widens the inferred shape
 * to `Record<string, any>`, which fails the static type at the
 * `createApp` call site. `artifactFields` is exported for reference /
 * runtime inspection.
 *
 * The CLI / env-driven entry that boots the service from environment
 * variables lives at `dist/cli.js` (run via `node dist/cli.js`).
 */

export {
  artifactFields,
  ArtifactSchema,
  schemaForPrompt,
  type Artifact,
} from "./artifact.js";
