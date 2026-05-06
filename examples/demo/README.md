# @flowajs/demo

End-to-end worked example for the flowa stack.

The demo wires `@flowajs/chat-service` against the public `prompts/generic/`
prompt set and a fixture aggregate, so you can exercise the chat surface
end-to-end on a laptop without an actual pipeline run.

## Requirements

- **Node 24+** (uses the built-in `node:sqlite` for triage state).
  A `.nvmrc` at the repo root pins this; with `nvm`/`fnm`/`volta`,
  `nvm use` (or equivalent) selects the right version automatically.
- **uv** on `PATH`. Install via the standalone shell installer
  (<https://docs.astral.sh/uv/getting-started/installation/>),
  Homebrew (`brew install uv`), or `pip install uv`. The demo's
  start script probes for it and prints a clear error if it's
  missing.
- A credential for one of the supported LLM providers
  (`anthropic`, `bedrock`, `google-gla`, `google-vertex`, `openai`).

## Quickstart

```bash
cd examples/demo
cp .env.example .env
# Edit .env: uncomment exactly one provider block, fill in your key.

pnpm install               # from the repo root, also fine
pnpm --filter @flowajs/demo demo
```

`pnpm run demo` boots three processes via `concurrently`:

- **Next.js** on port 7700 — hosts the triage API (`/api/triage/*`)
  and a single read-only progress endpoint
  (`/api/runs/[runId]/progress`) that streams the on-disk
  `progress.jsonl` file. The browser talks to chat-service and
  demo-gateway directly for everything else (no proxies — see the
  note below).
- **chat-service** on port 7701 — the deployment-style entry that
  loads `prompts/generic/aggregate_edit_schema.ts` and passes it
  into `createApp({ schema })`.
- **demo-gateway** on port 7702 — Python FastAPI service wrapping
  `flowa.run.run_pipeline(...)` for pipeline submission and
  active-run lookup. See `examples/demo-gateway/README.md`.

Override the ports via `DEMO_NEXT_PORT` / `CHAT_SERVICE_PORT` /
`DEMO_GATEWAY_PORT` if 7700 / 7701 / 7702 are already taken locally.

## Demo simplifications (read this before reusing patterns)

The demo collapses several boundaries that a real deployment would
keep separate:

- The browser talks **directly** to chat-service (`:7701`) and
  demo-gateway (`:7702`) over CORS. A real deployment puts both
  behind an authenticated edge and never exposes them to the
  browser cross-origin; the deployment's own authenticated server
  proxies through with credentials minted in the request handler.
- Progress is read from a **local file** at
  `./demo-data/runs/{runId}/progress.jsonl`. A real deployment
  publishes events to a stream / object store; the file shape and
  the `ProgressEvent` schema are the contract, not the local-fs
  transport.
- Active-run state lives **in demo-gateway's process memory** and is
  lost on restart. A real deployment persists run records and uses
  a worker queue.

The chat-service and `flowa.run.run_pipeline` surfaces themselves
aren't bound to any of those choices — they're consumable from any
HTTP wiring the deployment prefers.

## Layout

```text
examples/demo/
├── .env.example        Provider creds + optional overrides.
├── next.config.mjs     Next.js (Pages Router) config.
├── tsconfig.json       Extends ../../tsconfig.base.json.
├── scripts/
│   ├── chat-service.ts   Deployment-style entry: imports the generic
│   │                     ArtifactSchema, builds a Storage rooted at
│   │                     ./demo-data/, calls createApp({ schema }).
│   └── start.ts          Boot orchestrator (concurrently).
├── src/
│   ├── db/
│   │   ├── schema.sql    SQLite tables for triage state.
│   │   └── migrate.ts    Idempotent on-boot migration.
│   ├── lib/
│   │   └── triageDb.ts   Server-side triage operations.
│   └── pages/api/
│       └── triage/                             Triage state CRUD.
│           ├── claim.ts
│           ├── comment.ts
│           ├── paper-done.ts
│           └── snapshot/[variantId]/[category]/[version].ts
├── fixtures/
│   └── (hand-crafted aggregate + papers, copied to ./demo-data/ on first boot)
└── test/
    ├── triage.test.ts          SQLite + API route round-trip.
    └── chat-service.test.ts    Smoke test for the entry script.
```

The in-browser triage workspace and literature view live in
`@flowajs/react-viewer` (`EvidenceViewerShell`, `LiteratureViewShell`).
The demo will host them as page components once those shells are
exported. Until then, the chat surface is exercisable via direct API
calls (see `test/`).

## SQLite

Triage state is persisted to `./demo-data/triage.sqlite` via the
built-in `node:sqlite` module. No native compilation, no postinstall
scripts — just Node 24+. The schema is in `src/db/schema.sql`; the
migrator runs idempotently on first API call.

## Fixture data

`fixtures/` ships a small hand-crafted aggregate (one variant,
~3 papers, ~5 claims) shaped per
`prompts/generic/aggregate_schema.py:CategoryResult` and the generic
artifact schema. On first boot, `scripts/start.ts` copies the fixture
tree to `./demo-data/` if it isn't already present, so chat-service has
artifacts to load when serving a session.

## Tests

```bash
pnpm --filter @flowajs/demo test
```

`vitest` covers:

- `test/triage.test.ts` — SQLite migrate idempotence, all four triage
  ops round-trip, isolated tmp dir per test.
- `test/chat-service.test.ts` — boot smoke for `scripts/chat-service.ts`,
  asserts `POST /sessions` returns 200 against the fixture aggregate.

## Deployment-style entry

`scripts/chat-service.ts` is the worked example of how an external
deployment wires `@flowajs/chat-service`: import a Zod schema (here,
the generic one), construct a Storage and an LlmProvider via the
package's per-backend / per-provider factories, call
`createApp({ schema, storage, provider, ... })`, serve with
`@hono/node-server`. Production deployments differ only in the cred
chain used to mint SDK clients (e.g. OIDC→STS) before passing them
to the programmatic `{ client }` factory variants.
