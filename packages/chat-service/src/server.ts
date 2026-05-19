/** Programmatic API: construct a Hono app from injected storage / LLM /
 *  schema. The default env-driven entry in `index.ts` calls this. */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import type { Storage } from "./storage/interface.js";
import type { LlmProvider } from "./llm/interface.js";
import { ArtifactSchema, type Artifact } from "./artifact.js";
import {
  type SessionConfig,
  createEditSession,
  getCachedSession,
  rebuildSession,
} from "./session.js";
import { handleChat } from "./chat.js";
import { verifySessionToken } from "./auth/jwt.js";

export interface CreateAppOptions {
  storage: Storage;
  provider: LlmProvider;
  /**
   * Zod schema for the deployment's full artifact. Must extend the
   * citation-grounded core (see `artifactFields` in `./artifact.js`). Use
   * `ArtifactSchema` exported from this package as the default — that
   * schema is just the citation-grounded core itself.
   */
  schema?: z.ZodType<Artifact>;
  jwtSecret: string;
  /** Directory containing `aggregation_edit_prompt.txt`. */
  promptDir: string;
  /** Session token lifetime in seconds. Default: 4 hours. */
  jwtTtlSeconds?: number;
  /** Allowed CORS origins. Default: any. */
  corsOrigins?: string[];
}

/**
 * Construct a Hono app exposing chat-service's HTTP routes:
 *
 * - `GET /health` → `{ status: "ok" }`
 * - `POST /sessions` → creates an edit session, returns a session JWT.
 * - `POST /chat/:sessionId` → SSE stream of chat output.
 *
 * The app does **no upstream-IDP authentication** on `/sessions` — that
 * is a separate concern. Add the OIDC middleware (`createOidcMiddleware`
 * from `./auth/oidc`) in front of `/sessions` if your deployment needs
 * it. The session JWT on `/chat/:id` is enforced internally.
 */
export function createApp(options: CreateAppOptions): Hono {
  const schema = (options.schema ?? ArtifactSchema) as z.ZodType<Artifact>;
  const sessionConfig: SessionConfig = {
    storage: options.storage,
    schema,
    promptDir: options.promptDir,
    jwtSecret: options.jwtSecret,
    jwtTtlSeconds: options.jwtTtlSeconds ?? 14400,
  };

  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: options.corsOrigins ?? "*",
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
    }),
  );

  app.get("/health", (c) => c.json({ status: "ok" }));

  const createSessionBody = z.object({
    variant_id: z.string(),
    user_id: z.string(),
    category: z.string(),
    initial_artifact: z.string(),
    initial_version: z.number().int().nonnegative(),
  });

  app.post("/sessions", async (c) => {
    const body = createSessionBody.safeParse(await c.req.json());
    if (!body.success) {
      return c.json(
        { error: "Invalid request body", details: body.error.issues },
        400,
      );
    }

    try {
      const result = await createEditSession(sessionConfig, {
        variantId: body.data.variant_id,
        userId: body.data.user_id,
        category: body.data.category,
        initialArtifact: body.data.initial_artifact,
        initialVersion: body.data.initial_version,
      });
      return c.json({
        session_id: result.session.id,
        token: result.token,
        expires_at: result.expiresAt.toISOString(),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Session creation failed";
      return c.json({ error: message }, 422);
    }
  });

  app.post("/chat/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    let claims;
    try {
      claims = await verifySessionToken(authHeader.slice(7), {
        secret: sessionConfig.jwtSecret,
        ttlSeconds: sessionConfig.jwtTtlSeconds,
      });
    } catch {
      return c.json({ error: "Invalid or expired session token" }, 401);
    }

    if (claims.session_id !== sessionId) {
      return c.json({ error: "Session ID mismatch" }, 403);
    }

    let session = getCachedSession(sessionId);
    if (!session) {
      try {
        session = await rebuildSession(sessionConfig, claims, claims.expiresAt);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to rebuild session";
        return c.json({ error: message }, 500);
      }
    }

    return handleChat(
      {
        storage: options.storage,
        provider: options.provider,
        schema,
      },
      c.req.raw,
      session,
    );
  });

  return app;
}
