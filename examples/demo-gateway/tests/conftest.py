"""Shared fixtures.

Tests build a FastAPI app via `create_app(settings=...)` so each test gets
its own clean tmp data dir, then mount a `RunManager` with a stub pipeline
on `app.state.runs` directly — bypassing the production lifespan, which
would otherwise try to construct a real `flowa.settings.Settings` and fail
without the full `FLOWA_*` env block. TestClient is used without a
context-manager so the lifespan does not fire.
"""

from collections.abc import Awaitable, Callable
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from flowa.progress import ProgressCallback
from flowa.settings import ModelConfig
from flowa.settings import Settings as FlowaSettings

from demo_gateway.config import Settings
from demo_gateway.main import create_app
from demo_gateway.runs import RunManager

StubPipeline = Callable[..., Awaitable[None]]


def make_flowa_settings(storage_base: Path) -> FlowaSettings:
    """Construct a minimal FlowaSettings without reading env. We don't run
    the real pipeline in tests, so the model fields are placeholders."""
    return FlowaSettings.model_construct(
        flowa_storage_base=str(storage_base),
        flowa_conversion_model=ModelConfig(name='stub:test'),
        flowa_extraction_model=ModelConfig(name='stub:test'),
        flowa_aggregation_model=ModelConfig(name='stub:test'),
        flowa_prompt_set='generic',
        flowa_log_level='INFO',
        mastermind_api_token=None,
        ncbi_api_key=None,
    )


def install_runs(app: FastAPI, manager: RunManager) -> None:
    """Mount a RunManager on the app, bypassing the lifespan factory."""
    app.state.runs = manager


@pytest.fixture
def successful_pipeline() -> StubPipeline:
    """A pipeline coroutine that resolves cleanly with no events."""

    async def _stub(_settings: object, *, on_progress: ProgressCallback | None = None, **_kwargs: object) -> None:
        return None

    return _stub


@pytest.fixture
def failing_pipeline() -> StubPipeline:
    """A pipeline coroutine that raises immediately."""

    async def _stub(_settings: object, *, on_progress: ProgressCallback | None = None, **_kwargs: object) -> None:
        raise RuntimeError('flowa boom')

    return _stub


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(demo_data_dir=tmp_path, demo_max_concurrent_runs=3)


@pytest.fixture
def app(settings: Settings, tmp_path: Path, successful_pipeline: StubPipeline) -> FastAPI:
    a = create_app(settings=settings)
    install_runs(
        a,
        RunManager(
            flowa_settings=make_flowa_settings(tmp_path),
            data_dir=tmp_path,
            max_concurrent_runs=settings.demo_max_concurrent_runs,
            pipeline=successful_pipeline,
        ),
    )
    return a


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    return TestClient(app)
