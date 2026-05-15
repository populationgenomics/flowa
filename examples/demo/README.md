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
│   └── (aggregate + papers, copied to ./demo-data/ on first boot;
│       see LICENSES.md for attribution)
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

`fixtures/` ships a small aggregate (one variant) shaped per
`prompts/generic/aggregate_schema.py:CategoryResult` and the generic
artifact schema, along with the source PDFs and Markdown transcriptions
the aggregate cites. On first boot, `scripts/start.ts` copies the
fixture tree to `./demo-data/` if it isn't already present, so
chat-service has artifacts to load when serving a session.

Two CC-BY 4.0 PLOS ONE papers ship under `fixtures/papers/` with full
content (PDF + extracted Markdown + metadata); three more papers ship
metadata only (no PDF, no abstract) so the literature page can render
five rows that match what flowa originally queried, with the curator
dropping their own PDFs in via the upload UI. See `fixtures/LICENSES.md`
for per-paper attribution and the rule block to follow before staging
anything new under `fixtures/papers/`.

## Submitting a variant from the demo UI

`pnpm --filter @flowajs/demo demo` boots Next.js, chat-service, and
demo-gateway together. Open `http://localhost:7700/`, fill in a Gene
(e.g. `RYR2`) and HGVS c. (e.g. `NM_001035.3:c.14174A>G`), and submit.
The Next.js handler derives the `variant_id`
(`${gene}-${slug(transcript)}-${slug(change)}`, so
`RYR2-NM_001035_3-c_14174A_G` for the bundled fixture) and forwards
the run to demo-gateway. The page redirects to `/variants/[variantId]`,
which polls the run's progress JSONL, lists per-paper download/upload
status, and surfaces an "Open analysis" chip per category once
`aggregate.json` lands.

## Re-running an assessment from the CLI

Every pipeline stage (query → download → convert → extract → aggregate)
caches by output-file presence under `demo-data/`. To redo a stage,
delete its output and re-run; whatever's left is reused.

Resetting the bundled assessment for an end-to-end re-run, keeping
cached inputs that don't need redoing (query results, paper metadata,
downloaded PDFs):

```bash
cd examples/demo/demo-data
VARIANT=RYR2-NM_001035_3-c_14174A_G
# Run progress is now nested under the assessment dir; clear it
# alongside the aggregate so the next run starts clean.
rm -f assessments/$VARIANT/aggregate.json \
      assessments/$VARIANT/aggregate_raw.json
rm -rf assessments/$VARIANT/extractions/ assessments/$VARIANT/runs/
# Re-runs flowa.convert (which uses anchorite for PDF chunking).
# Drop this line to reuse the cached markdown and only redo extract +
# aggregate.
rm -f papers/*/markdown.md papers/*/convert_raw.json
```

Then drive the pipeline. The demo's `scripts/start.ts` translates the
demo's `.env` into the `FLOWA_*` shape `pydantic-settings` expects;
replicate that translation when invoking the CLI directly:

```bash
cd examples/demo && set -a && source .env && set +a && cd ../..
export FLOWA_STORAGE_BASE="$PWD/examples/demo/demo-data"
export FLOWA_EXTRACTION_MODEL__NAME="$LLM_MODEL"
export FLOWA_CONVERT_MODEL__NAME="$LLM_MODEL"
if [ -n "${BEDROCK_INFERENCE_PROFILE:-}" ]; then
  export FLOWA_EXTRACTION_MODEL__BEDROCK_INFERENCE_PROFILE="$BEDROCK_INFERENCE_PROFILE"
  export FLOWA_CONVERT_MODEL__BEDROCK_INFERENCE_PROFILE="$BEDROCK_INFERENCE_PROFILE"
fi
uv run flowa run --variant-id $VARIANT --gene RYR2 --hgvs-c "NM_001035.3:c.14174A>G"
```

Open `http://localhost:7700/viewer/$VARIANT/acmg_classification` (with
`pnpm --filter @flowajs/demo demo` running) to exercise the on-demand
citation-bbox alignment that demo-gateway's `/resolve-citations` serves.

A pre-`assessments/`-layout `demo-data/runs/` from an older dev run is
safe to delete — the current layout writes runs under
`demo-data/assessments/{variant_id}/runs/{run_id}/`.

## Capturing a fixture from a real run

To replace `examples/demo/fixtures/assessments/...` with a freshly
captured pipeline run, run the variant end-to-end (UI submission or
`flowa run`), then copy `demo-data/assessments/{variant_id}/` into
`fixtures/assessments/{variant_id}/`. Skip `aggregate_raw.json` and
`extractions/*_raw.json` — those are the raw LLM conversations, large,
and not needed by anything downstream.

For papers whose source license blocks redistribution (CC-BY-NC-ND
specifically; see `fixtures/LICENSES.md` for the rule), do **not** delete
the whole `papers/{encodedDoi}/` directory — only delete `source.pdf`,
`markdown.md`, and `convert_raw.json`. Keep `metadata.json` (the
bibliographic fields are factual data, not copyrightable) but strip its
`abstract` field for safety:

```bash
python3 -c "
import json
p = 'papers/<encoded-doi>/metadata.json'
d = json.load(open(p))
d.pop('abstract', None)
json.dump(d, open(p, 'w'), indent=2, ensure_ascii=False)
"
```

The metadata.json lets the literature page render the paper's title +
author list (so the row reads sensibly), while no derivative content
ships in the open-source repo.

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
