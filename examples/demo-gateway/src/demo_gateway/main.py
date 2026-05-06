"""FastAPI app exposing the pipeline as HTTP endpoints.

Endpoints:
  POST /runs           — kick off a pipeline run for a variant
  GET  /runs/active    — most recent run record for a variant (status == running while in flight)
  GET  /health         — liveness probe

The Next.js demo proxies the first two; it reads `progress.jsonl` directly
from the shared local filesystem rather than going through this gateway,
since both processes have access to the same files.
"""

import logging
from contextlib import asynccontextmanager
from typing import Annotated

import uvicorn
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .config import Settings
from .runs import RunManager, RunRecord, make_run_manager


def configure_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format='%(asctime)s %(levelname)s %(name)s: %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S',
    )


class TriggerRequest(BaseModel):
    """Body for POST /runs."""

    variant_id: str = Field(..., description='Variant identifier')
    gene: str = Field(..., description='Gene symbol (e.g., CFTR)')
    hgvs_c: str = Field(..., description='HGVS c. notation (e.g., c.1521_1523del)')


class RunResponse(BaseModel):
    """Response shape for /runs and /runs/active.

    Mirrors the standard wire shape so a real deployment's gateway can
    swap in without client changes.
    """

    run_id: str
    variant_id: str
    started_at: str
    status: str

    @classmethod
    def from_record(cls, record: RunRecord) -> 'RunResponse':
        return cls(
            run_id=record.run_id,
            variant_id=record.variant_id,
            started_at=record.started_at,
            status=record.status,
        )


def _runs(request: Request) -> RunManager:
    return request.app.state.runs


router = APIRouter()


@router.get('/health')
async def health() -> dict[str, str]:
    return {'status': 'ok'}


@router.post('/runs', response_model=RunResponse)
async def trigger_run(
    body: TriggerRequest,
    runs: Annotated[RunManager, Depends(_runs)],
) -> RunResponse:
    """Kick off a pipeline run. 409 if a run is already in flight for the
    variant; 429 if the concurrency cap is reached."""
    record = runs.start(variant_id=body.variant_id, gene=body.gene, hgvs_c=body.hgvs_c)
    return RunResponse.from_record(record)


@router.get('/runs/active', response_model=RunResponse)
async def get_active_run(
    runs: Annotated[RunManager, Depends(_runs)],
    variant_id: Annotated[str, Query(..., description='Variant identifier')],
) -> RunResponse:
    """Most recent run for `variant_id`. 404 if none exist for this variant.
    Status field reflects current state (`running` / `success` / `error`)."""
    record = runs.get_active(variant_id)
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f'no run for variant {variant_id}')
    return RunResponse.from_record(record)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = app.state.settings
    app.state.runs = make_run_manager(
        data_dir=settings.demo_data_dir,
        max_concurrent_runs=settings.demo_max_concurrent_runs,
    )
    logging.getLogger(__name__).info(
        'demo-gateway ready: data_dir=%s, max_concurrent_runs=%d',
        settings.demo_data_dir,
        settings.demo_max_concurrent_runs,
    )
    yield


def create_app(settings: Settings | None = None) -> FastAPI:
    """Construct the FastAPI app. Tests pass a custom Settings; production
    falls through to env-var defaults."""
    settings = settings or Settings()
    configure_logging(settings.log_level)

    app = FastAPI(
        title='Flowa Demo Gateway',
        description='Wraps flowa as HTTP endpoints for the in-tree demo.',
        version='0.0.0',
        lifespan=lifespan,
    )
    app.state.settings = settings
    # CORS: the demo's browser fetches /runs and /runs/active directly
    # from this service (no Next.js proxy). See README for why this is
    # demo-specific and how a real deployment would differ.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=['*'],
        allow_headers=['*'],
    )
    app.include_router(router)
    return app


app = create_app()


def main() -> None:
    """Console entry: `uv run demo-gateway` or `python -m demo_gateway.main`."""
    settings = Settings()
    uvicorn.run(
        'demo_gateway.main:app',
        host='127.0.0.1',
        port=settings.demo_gateway_port,
        log_level=settings.log_level.lower(),
    )


if __name__ == '__main__':
    main()
