/** Env-var schema for the default `index.ts` entry. */

import { z } from "zod";
import type { StorageConfig } from "./storage/factory.js";

const RequiredEnv = z.object({
  LLM_MODEL: z.string().min(1),
  STORAGE_BACKEND: z.enum(["fs", "s3", "gcs"]),
  CHAT_JWT_SECRET: z.string().min(1),
});

export interface ServiceConfig {
  port: number;
  llmModel: string;
  storage: StorageConfig;
  jwtSecret: string;
  jwtTtlSeconds: number;
  promptDir: string;
  corsOrigins: string[];
  oidc: {
    jwksUrl: string;
    issuer: string;
    audience: string;
  } | null;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  return v ? parseInt(v, 10) : fallback;
}

function buildStorageConfig(): StorageConfig {
  const backend = process.env.STORAGE_BACKEND;
  const prefix = process.env.STORAGE_PREFIX;
  if (backend === "fs") {
    const root = process.env.STORAGE_FS_ROOT;
    if (!root) {
      throw new Error("STORAGE_BACKEND=fs requires STORAGE_FS_ROOT to be set.");
    }
    return {
      backend: "fs",
      root,
      ...(prefix !== undefined ? { prefix } : {}),
    };
  }
  if (backend === "s3") {
    const bucket = process.env.STORAGE_S3_BUCKET;
    if (!bucket) {
      throw new Error(
        "STORAGE_BACKEND=s3 requires STORAGE_S3_BUCKET to be set.",
      );
    }
    return {
      backend: "s3",
      bucket,
      ...(prefix !== undefined ? { prefix } : {}),
    };
  }
  if (backend === "gcs") {
    const bucket = process.env.STORAGE_GCS_BUCKET;
    if (!bucket) {
      throw new Error(
        "STORAGE_BACKEND=gcs requires STORAGE_GCS_BUCKET to be set.",
      );
    }
    return {
      backend: "gcs",
      bucket,
      ...(prefix !== undefined ? { prefix } : {}),
    };
  }
  throw new Error(
    `STORAGE_BACKEND must be one of "fs", "s3", "gcs"; got: ${JSON.stringify(backend)}`,
  );
}

function buildOidcConfig(): ServiceConfig["oidc"] {
  const jwksUrl = process.env.OIDC_JWKS_URL;
  const issuer = process.env.OIDC_ISSUER;
  const audience = process.env.OIDC_AUDIENCE;
  if (!jwksUrl && !issuer && !audience) return null;
  if (!jwksUrl || !issuer || !audience) {
    throw new Error(
      "OIDC config is partial. Set all of OIDC_JWKS_URL, OIDC_ISSUER, OIDC_AUDIENCE, or none.",
    );
  }
  return { jwksUrl, issuer, audience };
}

export function loadConfig(): ServiceConfig {
  const required = RequiredEnv.safeParse(process.env);
  if (!required.success) {
    const names = required.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Missing or empty required env vars: ${names}`);
  }
  return {
    port: envInt("PORT", 8000),
    llmModel: required.data.LLM_MODEL,
    storage: buildStorageConfig(),
    jwtSecret: required.data.CHAT_JWT_SECRET,
    jwtTtlSeconds: envInt("CHAT_JWT_TTL_SECONDS", 14400),
    promptDir: process.env.CHAT_PROMPT_DIR ?? "./prompts",
    corsOrigins: (process.env.CHAT_CORS_ORIGINS ?? "*")
      .split(",")
      .map((o) => o.trim()),
    oidc: buildOidcConfig(),
  };
}
