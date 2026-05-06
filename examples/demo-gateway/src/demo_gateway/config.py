"""Configuration loaded from environment variables.

The orchestrator (`examples/demo/scripts/start.ts`) injects every value
relevant to the gateway when it spawns the subprocess. Running the gateway
standalone (`uv run demo-gateway`) requires the same env vars set in the
shell.
"""

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Demo-gateway configuration."""

    model_config = SettingsConfigDict(
        env_file='.env',
        env_file_encoding='utf-8',
        extra='ignore',
    )

    demo_data_dir: Path = Field(
        default=Path('./demo-data').resolve(),
        description="Storage root shared with Next.js. flowa's pipeline writes papers/ + assessments/ here.",
    )

    demo_gateway_port: int = Field(default=7702, description='Listening port.')

    demo_max_concurrent_runs: int = Field(
        default=3,
        description='Hard cap on concurrent pipeline tasks; 429 on overflow.',
    )

    cors_origins: list[str] = Field(
        default=['*'],
        description=(
            'CORS allow_origins for browser cross-origin calls. The demo runs '
            'on localhost only, so `*` is fine; a production deployment of '
            'something like this would put the gateway behind authenticated '
            'server middleware and never expose CORS to arbitrary origins.'
        ),
    )

    log_level: str = Field(default='INFO', description='Python root logger level.')
