/** Main streaming chat endpoint. */

import { randomUUID } from "node:crypto";
import {
  ToolLoopAgent,
  createAgentUIStream,
  createUIMessageStreamResponse,
  generateText,
  stepCountIs,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { trace } from "@opentelemetry/api";
import { z } from "zod";
import {
  withToolMetrics,
  recordTokenUsage,
  recordValidationError,
  recordToolValidationFailure,
  recordStorageWriteFailure,
  recordCachedInputTokens,
  type ToolMetricsContext,
} from "./telemetry.js";
import { type SessionContext, CITATION_INSTRUCTIONS } from "./session.js";
import {
  loadExtraction,
  loadMarkdown,
  writeEditDraft,
} from "./storage-keys.js";
import {
  logRequest,
  logStep,
  logResponse,
  markTurnTruncated,
} from "./audit.js";
import type { Artifact } from "./artifact.js";
import type { LlmProvider } from "./llm/interface.js";
import type { Storage } from "./storage/interface.js";
import {
  parseArtifactYaml,
  reattachBboxes,
  addLineNumbers,
  viewRange,
  insertAtLine,
  searchArtifact,
  artifactToYaml,
} from "./yaml.js";

const tracer = trace.getTracer("chat-service");

/** Maximum tool-loop steps per turn. The AI SDK default is 20; allow more
 *  because str_replace retries (escaping mismatches, etc.) can burn steps. */
const MAX_STEPS = 30;

function resolveDoi(session: SessionContext, paperId: string): string | null {
  return session.paperIds[paperId] ?? null;
}

function resolveDois(
  session: SessionContext,
  paperIds: string[],
): { dois: string[]; invalid: string[] } {
  const dois: string[] = [];
  const invalid: string[] = [];
  for (const paperId of paperIds) {
    const doi = resolveDoi(session, paperId);
    if (doi) dois.push(doi);
    else invalid.push(paperId);
  }
  return { dois, invalid };
}

// ---------------------------------------------------------------------------
// Triage state
// ---------------------------------------------------------------------------

export const TriageStateSchema = z.object({
  version_id: z.string().optional(),
  accepted: z
    .array(
      z.object({
        paper_id: z.string(),
        claim_index: z.number().int().positive(),
      }),
    )
    .default([]),
  rejected: z
    .array(
      z.object({
        paper_id: z.string(),
        claim_index: z.number().int().positive(),
      }),
    )
    .default([]),
  papers_done: z.array(z.string()).default([]),
  /**
   * Per-claim comments. Reviewers often explain why they rejected a claim
   * or what caveat applies to an accepted one; those notes are
   * rewrite-relevant.
   */
  comments: z
    .array(
      z.object({
        paper_id: z.string(),
        claim_index: z.number().int().positive(),
        body: z.string(),
      }),
    )
    .default([]),
});

export type TriageState = z.infer<typeof TriageStateSchema>;

/**
 * Render the `{triage_state}` prompt block. Resolves each claim identified
 * by `(paper_id, claim_index)` to human-readable form using the current
 * artifact, which has the same claim order the client observed.
 */
export function renderTriageStateBlock(
  artifact: Artifact,
  state: TriageState | null | undefined,
): string {
  if (!state) {
    return "No triage in progress; edit freely based on the reviewer's chat.";
  }

  const accKey = (p: string, i: number) => `${p}#${i}`;
  const accepted = new Set(
    state.accepted.map((c) => accKey(c.paper_id, c.claim_index)),
  );
  const rejected = new Set(
    state.rejected.map((c) => accKey(c.paper_id, c.claim_index)),
  );
  const papersDone = new Set(state.papers_done);
  const commentByClaim = new Map<string, string>();
  for (const c of state.comments ?? []) {
    if (c.body.trim())
      commentByClaim.set(accKey(c.paper_id, c.claim_index), c.body);
  }

  const claimsByPaper = new Map<string, string[]>();
  const paperOrder: string[] = [];
  const indexByPaper = new Map<string, number>();
  for (const claim of artifact.claims) {
    if (!claimsByPaper.has(claim.paper_id)) {
      claimsByPaper.set(claim.paper_id, []);
      paperOrder.push(claim.paper_id);
      indexByPaper.set(claim.paper_id, 0);
    }
    const idx = (indexByPaper.get(claim.paper_id) ?? 0) + 1;
    indexByPaper.set(claim.paper_id, idx);
    const key = accKey(claim.paper_id, idx);
    const paperDone = papersDone.has(claim.paper_id);
    let label: string;
    if (accepted.has(key)) label = "ACCEPTED";
    else if (rejected.has(key)) label = "REJECTED";
    else if (paperDone)
      label = "REJECTED*"; // unreviewed in triage-done paper
    else label = "PENDING";

    const suffix =
      label === "REJECTED*"
        ? "       *unreviewed; paper triage marked done → treat as rejected"
        : label === "PENDING"
          ? "          ← paper triage NOT marked done; do not cite unless accepted"
          : "";

    const rows = claimsByPaper.get(claim.paper_id)!;
    rows.push(
      `  [${claim.paper_id}]   ${label.padEnd(10)} ${claim.text}${suffix}`,
    );

    const comment = commentByClaim.get(key);
    if (comment) {
      const normalised = comment.trim().replace(/\r\n/g, "\n");
      for (const line of normalised.split("\n")) {
        rows.push(`      ↳ reviewer note: ${line}`);
      }
    }
  }

  const doneLines = paperOrder
    .filter((p) => papersDone.has(p))
    .map((p) => `  - ${p}`);
  const doneBlock = doneLines.length ? doneLines.join("\n") : "  (none yet)";

  const claimLines = paperOrder
    .flatMap((p) => claimsByPaper.get(p) ?? [])
    .join("\n");

  return [
    "Papers with triage marked done (reviewer has reviewed to their satisfaction for these):",
    doneBlock,
    "",
    "Claim triage (order matches claims[] order in the current artifact):",
    claimLines,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Content validation (citation-fidelity gate — runs on every commit)
// ---------------------------------------------------------------------------

const CITE_LINK_RE = /\[[^\]]*\]\(#cite:([^ )"]+)(?:\s+"([^"]*)")?\)/g;

/**
 * Validate claim/paper integrity and citation fidelity. Returns an array
 * of error messages; empty array means the artifact passes.
 *
 * `validPaperIds`, when provided, is the set of paper IDs known to the
 * session (from aggregate.paper_id_mapping). Every paper in
 * `artifact.papers[]` must be a member.
 */
export function validateArtifactContent(
  artifact: Artifact,
  validPaperIds?: Set<string>,
): string[] {
  const errors: string[] = [];

  const paperIds = artifact.papers.map((p) => p.paper_id);
  const paperIdSet = new Set(paperIds);

  if (paperIds.length !== paperIdSet.size) {
    const duplicates = paperIds.filter((pid, i) => paperIds.indexOf(pid) !== i);
    errors.push(
      `papers[] has duplicate paper_id(s): ${[...new Set(duplicates)].join(", ")}`,
    );
    recordValidationError("paper_id_duplicate");
  }

  if (validPaperIds !== undefined) {
    for (const pid of paperIds) {
      if (!validPaperIds.has(pid)) {
        errors.push(
          `papers[] contains unknown paper_id="${pid}" that is not in the session's paper_id_mapping`,
        );
        recordValidationError("paper_id_unknown_in_mapping");
      }
    }
  }

  for (const claim of artifact.claims) {
    if (!paperIdSet.has(claim.paper_id)) {
      errors.push(
        `claim cites paper_id="${claim.paper_id}" which is not present in papers[]`,
      );
      recordValidationError("claim_paper_missing");
    }
  }

  // Enforce grouping: claims must appear in contiguous runs per paper, and
  // the group order must match papers[].
  const firstSeen = new Map<string, number>();
  const lastSeen = new Map<string, number>();
  artifact.claims.forEach((claim, i) => {
    if (!firstSeen.has(claim.paper_id)) firstSeen.set(claim.paper_id, i);
    lastSeen.set(claim.paper_id, i);
  });
  for (const [pid, first] of firstSeen) {
    const last = lastSeen.get(pid)!;
    for (let i = first; i <= last; i++) {
      if (artifact.claims[i]?.paper_id !== pid) {
        errors.push(
          `claims[] must be grouped contiguously by paper_id — claim #${i + 1} breaks the "${pid}" group`,
        );
        recordValidationError("claims_not_contiguous");
        break;
      }
    }
  }
  // Group order must match papers[] order (papers without claims may be skipped).
  const claimPaperOrder = Array.from(firstSeen.keys());
  const paperRankIndex = new Map(paperIds.map((pid, i) => [pid, i]));
  for (let i = 1; i < claimPaperOrder.length; i++) {
    const prev = paperRankIndex.get(claimPaperOrder[i - 1]!);
    const cur = paperRankIndex.get(claimPaperOrder[i]!);
    if (prev !== undefined && cur !== undefined && prev > cur) {
      errors.push(
        `claims[] groups must match papers[] order — "${claimPaperOrder[i]}" (rank ${cur}) appears after "${claimPaperOrder[i - 1]}" (rank ${prev})`,
      );
      recordValidationError("claims_group_order");
      break;
    }
  }

  // Build (paper_id → set of quotes) for citation fidelity lookup.
  const claimQuotesByPaper = new Map<string, Set<string>>();
  for (const claim of artifact.claims) {
    const set = claimQuotesByPaper.get(claim.paper_id) ?? new Set<string>();
    for (const c of claim.citations) set.add(c.quote);
    claimQuotesByPaper.set(claim.paper_id, set);
  }

  // Check every #cite: marker in notes + description.
  for (const [field, text] of [
    ["notes", artifact.notes],
    ["description", artifact.description],
  ] as const) {
    CITE_LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CITE_LINK_RE.exec(text)) !== null) {
      const pid = m[1]!;
      const quote = m[2];
      if (!paperIdSet.has(pid)) {
        errors.push(`${field}: #cite:${pid} references an unknown paper_id`);
        recordValidationError("cite_unknown_paper_id");
        continue;
      }
      if (quote === undefined) {
        errors.push(
          `${field}: citation link for paper ${pid} is missing a "verbatim quote" title attribute`,
        );
        recordValidationError("cite_missing_quote");
        continue;
      }
      const quotes = claimQuotesByPaper.get(pid);
      if (!quotes || !quotes.has(quote)) {
        errors.push(
          `${field}: quote referenced by #cite:${pid} does not match any claim.citations[].quote for paper "${pid}" (quote: ${JSON.stringify(quote)})`,
        );
        recordValidationError("cite_quote_mismatch");
      }
    }
  }

  return errors;
}

/** Shared validation + commit for str_replace, insert, and write. */
function validateAndCommit(
  session: SessionContext,
  schema: z.ZodType<Artifact>,
  updatedYaml: string,
  tool: "str_replace" | "insert" | "write",
): string | { error: string; is_error: true } {
  let parsed: unknown;
  try {
    parsed = parseArtifactYaml(updatedYaml);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    recordToolValidationFailure(tool);
    return { error: `Edit produced invalid YAML: ${msg}`, is_error: true };
  }

  const validation = schema.safeParse(parsed);
  if (!validation.success) {
    const issues = validation.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    recordToolValidationFailure(tool);
    return {
      error: `Edit produced invalid artifact: ${issues}`,
      is_error: true,
    };
  }

  const newCategory = validation.data.category;
  if (
    newCategory !== session.category &&
    session.aggregateCategories.includes(newCategory)
  ) {
    recordToolValidationFailure(tool);
    return {
      error: `Category ${newCategory} already has a result for this aggregate.`,
      is_error: true,
    };
  }

  const contentErrors = validateArtifactContent(
    validation.data,
    new Set(Object.keys(session.paperIds)),
  );
  if (contentErrors.length) {
    recordToolValidationFailure(tool);
    return {
      error: `Edit produced an artifact that fails content validation: ${contentErrors.join("; ")}`,
      is_error: true,
    };
  }

  session.artifactYaml = updatedYaml;
  session.artifactDirty = true;
  return "Edit applied successfully.";
}

interface ChatBuildContext {
  session: SessionContext;
  storage: Storage;
  provider: LlmProvider;
  schema: z.ZodType<Artifact>;
}

export function buildTools(ctx: ChatBuildContext) {
  const { session, storage, provider, schema } = ctx;
  const metricsContext: ToolMetricsContext = { providerName: provider.name };

  return {
    loadPaperExtracts: {
      description: "Load structured extraction results for specific papers.",
      inputSchema: z.object({
        paperIds: z
          .array(z.string())
          .describe("Paper IDs (e.g. ['Miyata2018', 'Smith2020'])"),
      }),
      execute: withToolMetrics(
        metricsContext,
        "loadPaperExtracts",
        async ({ paperIds: ids }: { paperIds: string[] }) => {
          console.log(`[tool] loadPaperExtracts: ${ids.join(", ")}`);
          const { dois, invalid } = resolveDois(session, ids);
          if (invalid.length)
            return { error: `Unknown paper IDs: ${invalid.join(", ")}` };
          const results = await Promise.all(
            dois.map((doi) => loadExtraction(storage, session.variantId, doi)),
          );
          return ids.map((id: string, i: number) => ({
            paperId: id,
            extraction: results[i],
          }));
        },
      ),
    },

    loadFullPaper: {
      description:
        "Load the full Markdown text of a paper into conversation context. Use when the reviewer wants to discuss specific passages.",
      inputSchema: z.object({
        paperId: z.string().describe("Paper ID (e.g. 'Miyata2018')"),
      }),
      execute: withToolMetrics(
        metricsContext,
        "loadFullPaper",
        async ({ paperId }: { paperId: string }) => {
          console.log(`[tool] loadFullPaper: ${paperId}`);
          const doi = resolveDoi(session, paperId);
          if (!doi) return { error: `Unknown paper ID: ${paperId}` };
          const text = await loadMarkdown(storage, doi);
          if (!text) return { error: `Full text not available for ${paperId}` };
          console.log(
            `[tool] loadFullPaper: ${paperId} → ${text.length} chars`,
          );
          return text;
        },
      ),
    },

    queryPapers: {
      description:
        "Run a subagent that reads the full text of the specified papers and answers a question about them. The paper texts are not added to this conversation's context, keeping it lean. Prefer this over loadFullPaper unless the reviewer needs the text to remain available for follow-up discussion.",
      inputSchema: z.object({
        question: z.string().describe("The specific question to answer"),
        paperIds: z.array(z.string()).describe("Paper IDs to query"),
      }),
      execute: withToolMetrics(
        metricsContext,
        "queryPapers",
        async ({
          question,
          paperIds: ids,
        }: {
          question: string;
          paperIds: string[];
        }) => {
          console.log(`[tool] queryPapers: ${ids.join(", ")} — "${question}"`);
          const { dois, invalid } = resolveDois(session, ids);
          if (invalid.length)
            return { error: `Unknown paper IDs: ${invalid.join(", ")}` };
          const texts = await Promise.all(
            dois.map((doi) => loadMarkdown(storage, doi)),
          );
          const available = ids
            .map((id: string, i: number) =>
              texts[i] ? `## ${id}\n\n${texts[i]}` : null,
            )
            .filter(Boolean);
          if (!available.length)
            return {
              error: "No full texts available for the requested papers",
            };
          const { text, usage } = await generateText({
            model: provider.model,
            providerOptions: provider.providerOptions,
            experimental_telemetry: {
              isEnabled: true,
              recordInputs: false,
              recordOutputs: false,
              functionId: "query-papers",
            },
            prompt: `${available.join("\n\n---\n\n")}\n\n${CITATION_INSTRUCTIONS}\n\nQuestion: ${question}`,
          });
          if (usage) {
            const modelLabel = provider.name;
            if (usage.inputTokens)
              recordTokenUsage({
                model: modelLabel,
                tokenType: "input",
                count: usage.inputTokens,
              });
            if (usage.outputTokens)
              recordTokenUsage({
                model: modelLabel,
                tokenType: "output",
                count: usage.outputTokens,
              });
          }
          return text;
        },
      ),
    },

    view: {
      description:
        "View the current artifact with line numbers. The artifact is shown with line numbers " +
        "in your initial context — use this only to re-read after edits. Use view_range to " +
        "read specific lines instead of the entire artifact.",
      inputSchema: z.object({
        view_range: z
          .tuple([z.number(), z.number()])
          .optional()
          .describe(
            "Optional [start, end] line range (1-indexed). Use -1 for end to mean end of file. " +
              "Omit to view the entire artifact.",
          ),
      }),
      execute: withToolMetrics(
        metricsContext,
        "view",
        async ({ view_range }: { view_range?: [number, number] }) => {
          if (!session.artifactYaml) {
            return { error: "Artifact not initialized" };
          }
          if (view_range) {
            return viewRange(
              session.artifactYaml,
              view_range[0],
              view_range[1],
            );
          }
          return addLineNumbers(session.artifactYaml);
        },
      ),
    },

    search: {
      description:
        "Find lines in the artifact YAML containing a literal substring. Returns each match with one line of context either side, prefixed with line numbers.",
      inputSchema: z.object({
        pattern: z
          .string()
          .describe("Literal substring to find (case-sensitive, no regex)."),
      }),
      execute: withToolMetrics(
        metricsContext,
        "search",
        async ({ pattern }: { pattern: string }) => {
          if (!session.artifactYaml) {
            return { error: "Artifact not initialized" };
          }
          const { output, count } = searchArtifact(
            session.artifactYaml,
            pattern,
          );
          if (count === 0) return `No matches for ${JSON.stringify(pattern)}.`;
          return `${count} match${count === 1 ? "" : "es"}:\n${output}`;
        },
      ),
    },

    str_replace: {
      description:
        "Exact string replacement on the artifact YAML. The replacement must match exactly once. " +
        "Each call in a turn operates on the result of prior edits (applied sequentially). " +
        "The result is validated against the artifact schema; if invalid, the edit is rejected. " +
        "IMPORTANT: Do NOT include line numbers in old_str or new_str — line numbers are for " +
        "display only. Use the raw artifact text.",
      inputSchema: z.object({
        old_str: z
          .string()
          .describe(
            "Exact text to find in the artifact (without line numbers). Must match exactly once.",
          ),
        new_str: z
          .string()
          .describe("Replacement text (without line numbers)."),
      }),
      execute: withToolMetrics(
        metricsContext,
        "str_replace",
        async ({ old_str, new_str }: { old_str: string; new_str: string }) => {
          if (!session.artifactYaml) {
            return { error: "Artifact not initialized", is_error: true };
          }

          const parts = session.artifactYaml.split(old_str);
          const matchCount = parts.length - 1;
          if (matchCount === 0) {
            return { error: "old_str not found in artifact.", is_error: true };
          }
          if (matchCount > 1) {
            return {
              error: `Found ${matchCount} matches for old_str. Provide more context for a unique match.`,
              is_error: true,
            };
          }

          const updated = session.artifactYaml.replace(old_str, new_str);
          return validateAndCommit(session, schema, updated, "str_replace");
        },
      ),
    },

    insert: {
      description:
        "Insert text after a specific line number in the artifact YAML. " +
        "Use line 0 to insert at the beginning. " +
        "The result is validated against the artifact schema; if invalid, the insert is rejected.",
      inputSchema: z.object({
        insert_line: z
          .number()
          .describe(
            "Line number after which to insert (1-indexed, 0 for beginning).",
          ),
        new_str: z.string().describe("Text to insert (without line numbers)."),
      }),
      execute: withToolMetrics(
        metricsContext,
        "insert",
        async ({
          insert_line,
          new_str,
        }: {
          insert_line: number;
          new_str: string;
        }) => {
          if (!session.artifactYaml) {
            return { error: "Artifact not initialized", is_error: true };
          }

          const updated = insertAtLine(
            session.artifactYaml,
            insert_line,
            new_str,
          );
          return validateAndCommit(session, schema, updated, "insert");
        },
      ),
    },

    write: {
      description:
        "Replace the entire artifact with new YAML. Use this for wholesale changes — applying triage decisions, major re-ranking, or restructuring. Prefer str_replace/insert for small, surgical edits. The provided YAML must parse and validate against the artifact schema.",
      inputSchema: z.object({
        artifact_yaml: z
          .string()
          .describe(
            "Complete new artifact content as YAML. Replaces the entire artifact.",
          ),
      }),
      execute: withToolMetrics(
        metricsContext,
        "write",
        async ({ artifact_yaml }: { artifact_yaml: string }) => {
          return validateAndCommit(session, schema, artifact_yaml, "write");
        },
      ),
    },
  };
}

const chatRequestBody = z.object({
  messages: z.array(z.unknown()),
  triage_state: TriageStateSchema.optional(),
});

export interface HandleChatContext {
  storage: Storage;
  provider: LlmProvider;
  schema: z.ZodType<Artifact>;
}

export async function handleChat(
  ctx: HandleChatContext,
  req: Request,
  session: SessionContext,
): Promise<Response> {
  const { storage, provider, schema } = ctx;
  const raw = (await req.json()) as unknown;
  const parsed = chatRequestBody.safeParse(raw);
  if (!parsed.success) {
    return new Response(
      JSON.stringify({
        error: "Invalid request body",
        details: parsed.error.issues,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  const messages = parsed.data.messages as UIMessage[];
  const triageState = parsed.data.triage_state ?? null;

  console.log(
    `[chat] session=${session.id} messages=${messages.length} triage=${triageState ? "yes" : "no"}`,
  );

  await logRequest({
    sessionId: session.id,
    userId: session.userId,
    variantId: session.variantId,
    messages,
  });

  // Triage state is prepended as a synthesised user message at the head of
  // this turn's messages array rather than being spliced into the system
  // prompt. That keeps session.systemPrompt byte-stable across turns so
  // prompt caching can reuse it as a cached prefix even when reviewer
  // triage decisions change. (If we baked triage into the system prompt,
  // any decision flip between turns would invalidate the entire cached
  // prefix — the largest part of every request.)
  const currentArtifact = parseArtifactYaml(session.artifactYaml) as Artifact;
  const triageBlock = renderTriageStateBlock(currentArtifact, triageState);
  const triageMessage: UIMessage = {
    id: `triage-state-${randomUUID()}`,
    role: "user",
    parts: [
      {
        type: "text",
        text: `Reviewer triage state for this turn:\n\n${triageBlock}`,
      },
    ],
  };
  const augmentedMessages: UIMessage[] = [triageMessage, ...messages];

  const tools = buildTools({ session, storage, provider, schema });

  return tracer.startActiveSpan(
    "chat.turn",
    {
      attributes: {
        "session.id": session.id,
        "variant.id": session.variantId,
        "user.id": session.userId,
        "triage.active": triageState != null,
      },
    },
    async (span) => {
      const agent = new ToolLoopAgent({
        model: provider.model,
        instructions: session.systemPrompt,
        providerOptions: provider.providerOptions,
        tools,
        stopWhen: stepCountIs(MAX_STEPS),
        experimental_telemetry: {
          isEnabled: true,
          recordInputs: false,
          recordOutputs: false,
          functionId: "chat-agent",
        },
        ...(provider.prepareStep ? { prepareStep: provider.prepareStep } : {}),
        onStepFinish: (step) => {
          console.log(
            `[chat] step finished: reason=${step.finishReason} text=${step.text.length} chars toolCalls=${step.toolCalls?.length ?? 0}`,
          );
          void logStep({
            sessionId: session.id,
            finishReason: step.finishReason,
            text: step.text,
            toolCalls: step.toolCalls ?? [],
            toolResults: (step.toolResults ?? []).map((r) => ({
              toolName: (r as { toolName?: string }).toolName,
              output: r.output,
            })),
          });
        },
        onFinish: async ({ text, toolCalls, usage, steps, finishReason }) => {
          console.log(
            `[chat] finished: ${text.length} chars, ${toolCalls?.length ?? 0} tool calls, usage=${JSON.stringify(usage)}`,
          );
          if (usage) {
            const modelLabel = provider.name;
            if (usage.inputTokens)
              recordTokenUsage({
                model: modelLabel,
                tokenType: "input",
                count: usage.inputTokens,
              });
            if (usage.outputTokens)
              recordTokenUsage({
                model: modelLabel,
                tokenType: "output",
                count: usage.outputTokens,
              });
            if (usage.cachedInputTokens)
              recordCachedInputTokens({
                model: modelLabel,
                type: "read",
                count: usage.cachedInputTokens,
              });
          }
          const truncated =
            steps.length >= MAX_STEPS && finishReason !== "stop";
          if (truncated) {
            console.log(
              `[edit] step limit reached (${steps.length}/${MAX_STEPS}) — draft may be incomplete`,
            );
            markTurnTruncated(session.id);
          }
          await logResponse(storage, {
            sessionId: session.id,
            userId: session.userId,
            response: text,
            toolCalls,
            usage,
          });
        },
      });

      // Build the UI message stream, then intercept the `finish` chunk to
      // write the edit draft (if dirty) and attach the new
      // {version, parent_version} as message metadata. Doing the write
      // inside this transform — rather than in onFinish — guarantees the
      // finish chunk carries the metadata: messageMetadata callbacks fire
      // before onFinish is awaited.
      const baseStream = await createAgentUIStream({
        agent,
        uiMessages: augmentedMessages,
        sendReasoning: true,
      });
      const stream = baseStream.pipeThrough(
        new TransformStream<UIMessageChunk, UIMessageChunk>({
          async transform(chunk, controller) {
            if (chunk.type !== "finish") {
              controller.enqueue(chunk);
              return;
            }
            try {
              if (session.artifactDirty) {
                const parsedArtifact = parseArtifactYaml(
                  session.artifactYaml,
                ) as Artifact;
                const withBboxes = reattachBboxes(
                  parsedArtifact,
                  session.bboxCache,
                );
                const parentVersion = session.artifactVersion;
                const writtenVersion = await writeEditDraft(
                  storage,
                  session.variantId,
                  session.category,
                  JSON.stringify(withBboxes),
                  parentVersion + 1,
                );
                session.artifactVersion = writtenVersion;
                session.artifactDirty = false;
                console.log(
                  `[edit] persisted draft v${writtenVersion} (parent v${parentVersion}) for ${session.variantId}/${session.category}`,
                );
                controller.enqueue({
                  ...chunk,
                  messageMetadata: {
                    artifact_write: {
                      version: writtenVersion,
                      parent_version: parentVersion,
                    },
                  },
                });
                return;
              }
              controller.enqueue(chunk);
            } catch (err) {
              console.error(
                `[edit] failed to persist draft for ${session.variantId}/${session.category}`,
                err,
              );
              recordStorageWriteFailure();
              controller.error(err);
            } finally {
              span.end();
            }
          },
        }),
      );
      return createUIMessageStreamResponse({ stream });
    },
  );
}

// Surface helpers for tests.
export { validateAndCommit, artifactToYaml };
