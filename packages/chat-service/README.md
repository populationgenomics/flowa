# `@flowajs/chat-service`

Stateless service that orchestrates LLM conversations over flowa artifacts.
Reads aggregates and papers from a configurable storage backend, applies edits
to a Zod-validated artifact schema, persists draft versions back to storage,
and streams SSE chat responses.

Two consumption modes:

- The flowa demo (`examples/demo`) depends on it via `workspace:*` and runs
  the default env-driven entry (`node dist/index.js`).
- External and production deployments install via npm (`pnpm add
  @flowajs/chat-service`) and wrap the programmatic API (`createApp(...)`)
  with custom storage / LLM / auth wiring. See
  [Production deployment](#production-deployment).

## Architecture

```text
┌─ HTTP (Hono) ───────────────────────────────────────────┐
│  POST /sessions   POST /chat/:id   GET /health          │
└────────────┬────────────────────────────────────────────┘
             │
       createApp({ storage, provider, jwtSecret, ... })
             │
   ┌─────────┴─────────┐
   ▼                   ▼
Storage              LlmProvider
  fs | s3 | gcs   anthropic | bedrock | google-gla
                  google-vertex | openai
```

The HTTP surface is provider-agnostic. Backends and the LLM provider are
constructed by the caller (env-driven default in `index.ts`, or programmatic
in a custom entry).

### Storage

`Storage` is a thin interface (5 ops: `read` / `write` / `writeIfAbsent` /
`exists` / `list`). Three backends are available:

- **`fs`** — POSIX local filesystem. Atomic create-only via
  `O_CREAT|O_EXCL`.
- **`s3`** — `@aws-sdk/client-s3`. Atomic create-only via `IfNoneMatch: '*'`.
  Region, endpoint, and credentials are resolved from the AWS SDK's standard
  env vars (`AWS_REGION`, `AWS_ENDPOINT_URL_S3`, `fromNodeProviderChain`); for
  S3-compatible providers (Cloudflare R2, Backblaze B2, MinIO, DigitalOcean
  Spaces, Wasabi, Hetzner, etc.) set those env vars to point at the provider.
  For knobs the SDK doesn't surface as env vars (e.g. `forcePathStyle`,
  custom retry policy), use the `{ client }` programmatic form.
- **`gcs`** — `@google-cloud/storage`. Atomic create-only via the
  `ifGenerationMatch: 0` precondition. Credentials come from Google Cloud's
  Application Default Credentials chain (`GOOGLE_APPLICATION_CREDENTIALS`,
  gcloud user creds, GCE metadata server, etc.). For deployments needing
  Workload Identity Federation or other custom cred-mint flows, use the
  `{ client }` programmatic form with a pre-built `Storage` client.

An Azure Blob backend is the next adapter when a consumer surfaces it; same
factory shape (`{ bucket, prefix? } | { client, bucket, prefix? }`).

### LLM providers

`LlmProvider` is a thin interface around a Vercel AI SDK `LanguageModel` plus
two optional knobs: `providerOptions` (per-provider thinking/reasoning
config) and `prepareStep(messages)` (per-step messages transformation, used
by Bedrock for prompt-cache point injection).

Five providers are supported: `anthropic`, `bedrock`, `google-gla`,
`google-vertex`, `openai`. Each ai-sdk package is an optional peer — install
only what you use. Selection at runtime via `LLM_MODEL=<provider>:<model>`.

### Authentication

chat-service issues and verifies its own session JWT (`POST /sessions` →
token; `POST /chat/:id` requires the token). Upstream-IDP authentication
(validating that the caller of `POST /sessions` is who they claim) is a
separate concern, exposed as a generic OIDC middleware:

```ts
import { createOidcMiddleware } from "@flowajs/chat-service/auth/oidc";

app.use("/sessions", createOidcMiddleware({
  jwksUrl: process.env.OIDC_JWKS_URL!,
  issuer: process.env.OIDC_ISSUER!,
  audience: process.env.OIDC_AUDIENCE!,
  // dev mode: decode the JWT body without verifying signature.
  // Useful for local dev with a stub IDP. NEVER enable in production.
  devMode: process.env.NODE_ENV === "development",
}));
```

The middleware works against any OIDC IDP (Auth0, Keycloak, Okta, GitHub,
etc.). The default env-driven `index.ts` applies it on `/sessions` when
`OIDC_JWKS_URL` is set; otherwise the route is unauthenticated.

## Environment configuration (default `index.ts`)

| Var | Required? | Purpose |
|-----|-----------|---------|
| `LLM_MODEL` | yes | `<provider>:<model>` — e.g. `bedrock:au.anthropic.claude-sonnet-4-6`, `anthropic:claude-sonnet-4-6`, `google-gla:gemini-2.5-pro`, `google-vertex:gemini-2.5-pro`, `openai:gpt-5`. |
| `STORAGE_BACKEND` | yes | One of `fs`, `s3`, `gcs`. |
| `STORAGE_FS_ROOT` | when `fs` | Absolute path to the storage root directory. |
| `STORAGE_S3_BUCKET` | when `s3` | Bucket name. Region, endpoint, and credentials come from the AWS SDK's standard env vars (`AWS_REGION`, `AWS_ENDPOINT_URL_S3`, `AWS_ACCESS_KEY_ID`, etc.); set those to point at AWS S3 or any S3-compat provider. |
| `STORAGE_GCS_BUCKET` | when `gcs` | Bucket name. Credentials come from Google Cloud's Application Default Credentials chain (`GOOGLE_APPLICATION_CREDENTIALS`, gcloud user creds, GCE metadata server, etc.). |
| `STORAGE_PREFIX` | no | Prefix prepended to every storage key (regardless of backend). |
| `CHAT_JWT_SECRET` | yes | Session JWT signing key. |
| `CHAT_PROMPT_DIR` | no, default `./prompts` | Directory containing `aggregate_edit_prompt.txt`. |
| `CHAT_JWT_TTL_SECONDS` | no, default `14400` | Session token lifetime (4h). |
| `PORT` | no, default `8000` | HTTP listen port. |
| `OTEL_ENABLED` | no, default `false` | When `true`, `instrumentation.ts` boots the OpenTelemetry SDK with SigV4 OTLP transport. The demo leaves this unset; production sets it to enable CloudWatch / X-Ray. |
| `BEDROCK_INFERENCE_PROFILE` | no | Application inference profile ARN for Bedrock cost attribution; only used when `LLM_MODEL` starts with `bedrock:`. |
| `OIDC_JWKS_URL`, `OIDC_ISSUER`, `OIDC_AUDIENCE` | no | When all three are set, `index.ts` applies the OIDC middleware on `POST /sessions`. |

Provider creds are read by each ai-sdk package via standard env vars
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`,
`GOOGLE_APPLICATION_CREDENTIALS` + `GOOGLE_VERTEX_PROJECT` +
`GOOGLE_VERTEX_LOCATION`, `AWS_REGION` + `AWS_ACCESS_KEY_ID` etc.). AWS S3
storage uses the AWS SDK's default credential chain
(`fromNodeProviderChain`).

## HTTP API

- `POST /sessions { variant_id, user_id, category, initial_artifact, initial_version }`
  → `{ session_id, token, expires_at }`
- `POST /chat/:sessionId { messages, triage_state? }` → SSE stream
- `GET /health` → `{ status: "ok" }`

## Production deployment

The default `index.ts` is sufficient when standard credential chains
(AWS env vars, IAM role, IRSA, etc.) cover your cred-mint flow. For
deployments that need custom cred minting (e.g. minting AWS STS credentials
from an OIDC IDP token in-process), write a small entry that uses the
programmatic API and injects pre-built SDK clients:

```ts
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { S3Client } from "@aws-sdk/client-s3";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createApp } from "@flowajs/chat-service/server";
import { createS3Storage } from "@flowajs/chat-service/storage/s3";
import { createBedrockProvider } from "@flowajs/chat-service/llm/bedrock";
import { createOidcMiddleware } from "@flowajs/chat-service/auth/oidc";
import { yourCustomCredentialProvider } from "./creds.js";

// Build a credential provider that refreshes on expiry. The AWS SDK
// invokes it on each request that needs creds.
const credentials = yourCustomCredentialProvider();

// Storage: pre-built S3Client bound to the custom credential provider.
const s3 = new S3Client({ region: "us-east-1", credentials });
const storage = createS3Storage({
  client: s3,
  bucket: "my-bucket",
  prefix: "flowa/",
});

// LLM: pre-built bedrock client bound to the same credential provider.
const bedrockClient = createAmazonBedrock({
  region: "us-east-1",
  credentialProvider: async () => {
    const c = await credentials();
    return {
      accessKeyId: c.accessKeyId,
      secretAccessKey: c.secretAccessKey,
      sessionToken: c.sessionToken,
    };
  },
});
const provider = createBedrockProvider({
  modelId: "us.anthropic.claude-sonnet-4-6",
  client: bedrockClient,
});

const chatApp = createApp({
  storage,
  provider,
  jwtSecret: process.env.CHAT_JWT_SECRET!,
  promptDir: "./prompts",
});

// Compose with custom auth middleware. The OIDC validator shipped with
// chat-service handles standard JWKS verification; substitute your own
// middleware if your IDP needs something else.
const app = new Hono();
app.use("/sessions", createOidcMiddleware({
  jwksUrl: process.env.OIDC_JWKS_URL!,
  issuer: process.env.OIDC_ISSUER!,
  audience: process.env.OIDC_AUDIENCE!,
}));
app.route("/", chatApp);

serve({ fetch: app.fetch, port: 8000 });
```

## Build and run

```bash
pnpm install
pnpm --filter @flowajs/chat-service typecheck
pnpm --filter @flowajs/chat-service test
pnpm --filter @flowajs/chat-service build
node packages/chat-service/dist/index.js
```

A reference `Dockerfile` is included as a starting point. Production
deployments that need a custom entry install `@flowajs/chat-service` from
npm and write their own thin entry that calls `createApp(...)` — see
[Production deployment](#production-deployment).
