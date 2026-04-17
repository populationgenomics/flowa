"""Centralized configuration via environment variables."""

from pydantic import BaseModel
from pydantic_settings import BaseSettings, SettingsConfigDict


class ModelConfig(BaseModel):
    """LLM model configuration with optional provider-specific extras.

    Callers (extract.py, aggregate.py, convert.py) treat this as opaque: it's
    constructed at startup from env vars and threaded through to `models.py`,
    which consumes the provider-specific fields.

    Built from nested env vars via `env_nested_delimiter='__'`, e.g.
    `FLOWA_EXTRACTION_MODEL__NAME=...`,
    `FLOWA_EXTRACTION_MODEL__BEDROCK_INFERENCE_PROFILE=...`.
    """

    name: str
    """Pydantic AI model string, e.g. `bedrock:au.anthropic.claude-sonnet-4-6`,
    `anthropic:claude-sonnet-4-6`, `openai:gpt-5`."""

    bedrock_inference_profile: str | None = None
    """Bedrock application inference profile ARN, used as the wire-level modelId for
    cost attribution. When set, `name` must point to the underlying foundation model
    so the correct Bedrock profile (with constrained-sampling support) resolves."""


class Settings(BaseSettings):
    """All configuration for the flowa pipeline.

    Construct at startup to validate all required env vars are present.
    Pass individual fields to functions that need them.
    """

    model_config = SettingsConfigDict(
        env_file='.env',
        env_file_encoding='utf-8',
        env_nested_delimiter='__',
        extra='ignore',
    )

    # Storage
    flowa_storage_base: str

    # Models
    flowa_convert_model: ModelConfig
    flowa_extraction_model: ModelConfig

    # Prompt set
    flowa_prompt_set: str = 'generic'

    # Logging
    flowa_log_level: str = 'INFO'

    # API keys (optional — not all sources/providers need all of these)
    mastermind_api_token: str | None = None
    ncbi_api_key: str | None = None
