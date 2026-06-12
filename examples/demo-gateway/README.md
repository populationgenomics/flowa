# demo-gateway

A small FastAPI service that wraps the `flowa` library so the in-tree
demo's Next.js app can trigger pipeline runs, look up active runs, and
resolve citation quotes to PDF bboxes over plain HTTP.

Deliberately scaled down: one Python process, ~300 LOC, no auth
(localhost only), in-memory active-run tracking, local-fs progress
files. Every one of those choices is wrong for a real deployment.

## What's reusable, what's a toy

The reusable surface is in `flowa`, not here:

- `flowa.run.run_pipeline(settings, *, on_progress=...)` — the public
  pipeline entry. Async; emits `ProgressEvent`s through `on_progress`.
- `flowa.progress.ProgressEvent` — the event schema is the stable
  contract between the pipeline and any consumer that wants progress.

This service's own machinery is throwaway demo wiring:

- The active-run dict in `RunManager` lives in process memory. A real
  deployment uses a job queue / workers and persistent run records.
- `ProgressSink` rewrites a local file on every event. A real
  deployment publishes to a stream (or PUTs to object storage).
- The browser fetches `/runs`, `/runs/active`, and `/resolve-citations`
  directly from this service with `CORSMiddleware: allow_origins=*`.
  A real deployment puts a gateway like this behind authenticated server
  middleware and never exposes it to the browser cross-origin.

If this code is useful as a starting point, treat the `flowa.run`
imports as load-bearing and the rest as something to replace.

## Endpoints

| Method | Path | Behaviour |
|---|---|---|
| `POST` | `/runs` | Body `{ variant_id, variant_spec }`, where `variant_spec` is the `flowa.schema.VariantSpec` envelope. Spawns the pipeline as an `asyncio` task and returns `{ run_id, started_at, status }` immediately. 409 if a run is already in flight for the variant; 429 at the concurrency cap. |
| `GET`  | `/runs/active?variant_id=X` | Most recent run for `variant_id` as `{ run_id, started_at, status }`. 404 if none. `status` is `running` while in flight; `success` / `error` once terminal. |
| `POST` | `/resolve-citations` | Body `{ citations: [{ doi, quotes[] }] }`. Builds fsspec-based PDF and Markdown loaders rooted at `DEMO_DATA_DIR/papers/{encoded_doi}/` and calls `flowa.resolve.resolve_citations(...)` synchronously. Returns `{ resolved: { doi: { quote: HighlightBbox[] } }, errors: { doi: string } }`. DOIs whose source PDF or markdown can't be loaded land in `errors`; quotes the aligner searches for but can't locate land as empty arrays in `resolved`. |
| `GET`  | `/health` | `{ "status": "ok" }`. |

`progress.jsonl` is written to the shared `DEMO_DATA_DIR` and read
directly by Next.js — there is no `/runs/{id}/progress` endpoint here.

## Config

| Var | Default | Purpose |
|---|---|---|
| `DEMO_DATA_DIR` | `./demo-data` | Storage root shared with Next.js. |
| `DEMO_GATEWAY_PORT` | `7702` | Listening port. |
| `DEMO_MAX_CONCURRENT_RUNS` | `3` | Hard cap on concurrent pipeline tasks (429 on overflow). |
| `LOG_LEVEL` | `INFO` | Python root logger level. |
| `FLOWA_*` | — | Required: `FLOWA_STORAGE_BASE`, `FLOWA_CONVERSION_MODEL__NAME`, `FLOWA_EXTRACTION_MODEL__NAME`, `FLOWA_AGGREGATION_MODEL__NAME`, etc. The demo's `start.ts` translates `LLM_MODEL` and `BEDROCK_INFERENCE_PROFILE` from the demo's `.env` into the corresponding `FLOWA_*` keys. |

## Standalone

The gateway is normally launched by the demo's `pnpm run demo`
orchestrator. To run it on its own:

```bash
cd examples/demo-gateway
uv run demo-gateway
```

## Tests

```bash
cd examples/demo-gateway
uv run pytest
```

Tests stub out the pipeline coroutine; no LLM calls are made.
