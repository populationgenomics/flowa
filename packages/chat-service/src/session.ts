/** Session management: creation, caching, and context building. */

import { randomUUID } from "node:crypto";
import nunjucks from "nunjucks";
import type { z } from "zod";
import { signSessionToken, type SessionClaims } from "./auth/jwt.js";
import {
  loadQueryResult,
  loadAggregate,
  loadMarkdown,
  loadPaperMetadata,
  listEditDrafts,
} from "./storage-keys.js";
import { schemaForPrompt, type Artifact } from "./artifact.js";
import {
  loadAuthoring,
  loadCategoryModule,
  loadEditPromptTemplate,
} from "./prompts.js";
import type { Storage } from "./storage/interface.js";
import {
  type LocationCache,
  buildLocationCache,
  artifactToYaml,
} from "./yaml.js";
import { addLineNumbers } from "./text.js";

export interface SessionContext {
  id: string;
  variantId: string;
  userId: string;
  /** Paper ID (e.g. "Miyata2018") → DOI / paper-key understood by storage. */
  paperIds: Record<string, string>;
  systemPrompt: string;
  expiresAt: Date;
  /** Current artifact as YAML (mutable via str_replace / insert / write). */
  artifactYaml: string;
  /** Current version number in the draft chain. */
  artifactVersion: number;
  /** Set to true when an edit modifies the artifact during a turn. */
  artifactDirty: boolean;
  /** Result selector (`category` in flowa-generic terms). Immutable for the session. */
  category: string;
  /** Cached citation locations from the initial artifact, keyed by (paperId, quote). */
  locationCache: LocationCache;
  /** Paper ID → full markdown text, lazy-populated by paper tools. */
  paperMarkdownCache: Map<string, string>;
}

export interface SessionConfig {
  /** Storage backend for aggregates / papers / edit drafts / audit log. */
  storage: Storage;
  /** Zod schema for the deployment's full artifact (extends the citation-grounded core). */
  schema: z.ZodType<Artifact>;
  /** A prompt set's `aggregation/` dir: `edit_prompt.txt`, `authoring.txt`, `categories.json`, `categories/`. */
  promptDir: string;
  /** Session JWT signing config. */
  jwtSecret: string;
  jwtTtlSeconds: number;
}

/** In-memory session cache. Not the source of truth — rebuilt from storage on miss. */
const sessions = new Map<string, SessionContext>();

let sweeper: ReturnType<typeof setInterval> | null = null;

function ensureSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(
    () => {
      const now = Date.now();
      for (const [id, ctx] of sessions) {
        if (ctx.expiresAt.getTime() < now) sessions.delete(id);
      }
    },
    30 * 60 * 1000,
  );
  sweeper.unref();
}

export function getCachedSession(
  sessionId: string,
): SessionContext | undefined {
  return sessions.get(sessionId);
}

/** For tests / shutdown: clear the in-memory cache. */
export function clearSessionCache(): void {
  sessions.clear();
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
}

/**
 * Resolve a paper ID to its full markdown text, memoised on the session.
 * Returns null for unknown paper IDs and for papers whose markdown is not
 * available in storage. Misses do not insert into the cache.
 */
export async function getPaperMarkdown(
  storage: Storage,
  session: SessionContext,
  paperId: string,
): Promise<string | null> {
  const cached = session.paperMarkdownCache.get(paperId);
  if (cached !== undefined) return cached;

  const doi = session.paperIds[paperId];
  if (!doi) return null;

  const text = await loadMarkdown(storage, doi);
  if (text === null) return null;

  session.paperMarkdownCache.set(paperId, text);
  return text;
}

/**
 * Rebuild session context from JWT claims (after restart or cache eviction).
 * Loads the latest draft from storage to restore artifact state. This loses
 * session-specific position if another session has written newer versions
 * in the meantime — acceptable for now.
 */
export async function rebuildSession(
  config: SessionConfig,
  claims: SessionClaims,
  expiresAt: Date,
): Promise<SessionContext> {
  ensureSweeper();
  const category = claims.category;
  const query = await loadQueryResult(config.storage, claims.variant_id);
  if (!query) {
    throw new Error(
      `No assessment data found for variant ${claims.variant_id}`,
    );
  }

  const [aggregate, drafts, ...paperMetadataResults] = await Promise.all([
    loadAggregate(config.storage, claims.variant_id),
    listEditDrafts(config.storage, claims.variant_id, category),
    ...query.dois.map((doi) => loadPaperMetadata(config.storage, doi)),
  ]);

  const paperMetadata = query.dois.map((doi, i) => ({
    doi,
    metadata: paperMetadataResults[i] ?? null,
  }));

  const paperIds = buildPaperIds(aggregate);
  const latestDraft = drafts.length > 0 ? drafts[drafts.length - 1] : null;

  let artifactJson: string;
  let artifactVersion: number;
  if (latestDraft) {
    artifactJson = latestDraft.artifactText;
    artifactVersion = latestDraft.version;
  } else {
    artifactJson = extractArtifactFromAggregate(aggregate, category);
    artifactVersion = 0;
  }

  const locationCache = buildLocationCache(artifactJson);
  const artifactYaml = artifactToYaml(artifactJson);

  const session: SessionContext = {
    id: claims.session_id,
    variantId: claims.variant_id,
    userId: claims.user_id,
    paperIds,
    systemPrompt: buildEditSystemPrompt({
      papers: paperMetadata,
      paperIds,
      artifactYaml,
      schema: config.schema,
      promptDir: config.promptDir,
      category,
    }),
    expiresAt,
    artifactYaml,
    artifactVersion,
    artifactDirty: false,
    category,
    locationCache,
    paperMarkdownCache: new Map(),
  };
  sessions.set(session.id, session);
  return session;
}

// ---------------------------------------------------------------------------
// Edit sessions
// ---------------------------------------------------------------------------

const promptEnv = new nunjucks.Environment(undefined, {
  autoescape: false,
  throwOnUndefined: true,
});

export interface EditSessionResult {
  session: SessionContext;
  token: string;
  expiresAt: Date;
}

export interface CreateEditSessionInput {
  variantId: string;
  userId: string;
  category: string;
  initialArtifact: string;
  initialVersion: number;
}

/**
 * Create a new edit session bound to a specific artifact version. The caller
 * passes the initial artifact JSON verbatim and the version number it came
 * from — chat-service stores these as-is.
 */
export async function createEditSession(
  config: SessionConfig,
  input: CreateEditSessionInput,
): Promise<EditSessionResult> {
  ensureSweeper();
  const query = await loadQueryResult(config.storage, input.variantId);
  if (!query) {
    throw new Error(`No assessment data found for variant ${input.variantId}`);
  }

  const [aggregate, ...paperMetadataResults] = await Promise.all([
    loadAggregate(config.storage, input.variantId),
    ...query.dois.map((doi) => loadPaperMetadata(config.storage, doi)),
  ]);

  if (!aggregate) {
    throw new Error(`No aggregate found for variant ${input.variantId}`);
  }

  const paperMetadata = query.dois.map((doi, i) => ({
    doi,
    metadata: paperMetadataResults[i] ?? null,
  }));

  const paperIds = buildPaperIds(aggregate);

  const locationCache = buildLocationCache(input.initialArtifact);
  const artifactYaml = artifactToYaml(input.initialArtifact);

  const systemPrompt = buildEditSystemPrompt({
    papers: paperMetadata,
    paperIds,
    artifactYaml,
    schema: config.schema,
    promptDir: config.promptDir,
    category: input.category,
  });

  const sessionId = randomUUID();
  const claims: SessionClaims = {
    session_id: sessionId,
    variant_id: input.variantId,
    user_id: input.userId,
    category: input.category,
  };
  const { token, expiresAt } = await signSessionToken(claims, {
    secret: config.jwtSecret,
    ttlSeconds: config.jwtTtlSeconds,
  });

  const session: SessionContext = {
    id: sessionId,
    variantId: input.variantId,
    userId: input.userId,
    paperIds,
    systemPrompt,
    expiresAt,
    artifactYaml,
    artifactVersion: input.initialVersion,
    artifactDirty: false,
    category: input.category,
    locationCache,
    paperMarkdownCache: new Map(),
  };
  sessions.set(sessionId, session);

  return { session, token, expiresAt };
}

/** Extract the artifact JSON for a category from aggregation.json. */
function extractArtifactFromAggregate(
  aggregate: unknown,
  category: string,
): string {
  if (
    typeof aggregate !== "object" ||
    aggregate === null ||
    !("results" in aggregate)
  ) {
    throw new Error("aggregation.json has no results");
  }
  const results = (aggregate as { results: { category: string }[] }).results;
  const result = results.find((r) => r.category === category);
  if (!result) {
    throw new Error(`Category ${category} not found in aggregation.json`);
  }
  return JSON.stringify(result, null, 2);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export const CITATION_INSTRUCTIONS = `## Citations

When referencing a finding from a paper, use inline Markdown citation links with a verbatim quote: \`[link text](#cite:paperId "verbatim quote")\`.

- The **link text** is free-form — use a descriptive phrase or specific claim, whatever reads naturally.
- The **title attribute** (in quotes after the href) must be a verbatim passage from the paper text — enough context to validate the claim (typically a sentence or key clause). The quote will be highlighted in the PDF for curators, so avoid quoting isolated values or single words that could match multiple locations — include surrounding context.
- When re-citing a finding from a paper's extraction results (loaded via loadPaperExtracts), reuse the exact quote string from the extraction's citation — do not rephrase or shorten it.
- When citing from a paper's text, quote the relevant passage verbatim.
- The href format \`#cite:paperId\` is required exactly — the application uses it to identify the paper.
- Be generous with links: whenever a factual claim can be traced to a specific passage, link it.`;

/** Extract paper ID → DOI mapping from the aggregate's paper_id_mapping. */
function buildPaperIds(aggregate: unknown): Record<string, string> {
  const ids: Record<string, string> = {};
  if (
    typeof aggregate === "object" &&
    aggregate !== null &&
    "paper_id_mapping" in aggregate
  ) {
    const mapping = (
      aggregate as { paper_id_mapping: Record<string, { doi: string }> }
    ).paper_id_mapping;
    for (const [authorYear, entry] of Object.entries(mapping)) {
      ids[authorYear] = entry.doi;
    }
  }
  return ids;
}

function invertPaperIds(
  paperIds: Record<string, string>,
): Record<string, string> {
  const inverted: Record<string, string> = {};
  for (const [id, doi] of Object.entries(paperIds)) {
    inverted[doi] = id;
  }
  return inverted;
}

function buildPaperIndex(
  papers: { doi: string; metadata: Record<string, unknown> | null }[],
  paperIds: Record<string, string>,
): string {
  const doiToPaperId = invertPaperIds(paperIds);
  return papers
    .map((p) => {
      const id = doiToPaperId[p.doi];
      if (!id) return null;
      const m = p.metadata;
      if (!m) return `- **${id}** — metadata unavailable`;
      const title = m.title ?? "Unknown title";
      const abstract = m.abstract ?? "";
      const pmid = m.pmid ? ` (PMID ${m.pmid})` : "";
      return `- **${id}**${pmid}: ${title}\n  ${abstract}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

interface BuildPromptArgs {
  papers: { doi: string; metadata: Record<string, unknown> | null }[];
  paperIds: Record<string, string>;
  artifactYaml: string;
  schema: z.ZodType<Artifact>;
  promptDir: string;
  /** The session's category — selects which domain module is injected. */
  category: string;
}

function buildEditSystemPrompt({
  papers,
  paperIds,
  artifactYaml,
  schema,
  promptDir,
  category,
}: BuildPromptArgs): string {
  const template = loadEditPromptTemplate(promptDir);
  const paperIndex = buildPaperIndex(papers, paperIds);

  // Mirror genesis composition: inject the shared authoring guidance and this
  // category's domain module as plain string values (never template-parsed),
  // so both sides render byte-identical fragments from one source.
  return promptEnv.renderString(template, {
    artifact_schema: schemaForPrompt(schema),
    paper_index: paperIndex,
    initial_artifact: addLineNumbers(artifactYaml),
    authoring: loadAuthoring(promptDir),
    category_module: loadCategoryModule(promptDir, category),
  });
}
