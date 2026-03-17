"""Centralized configuration via environment variables."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """All configuration for the flowa pipeline.

    Construct at startup to validate all required env vars are present.
    Pass individual fields to functions that need them.
    """

    model_config = SettingsConfigDict(env_file='.env', env_file_encoding='utf-8', extra='ignore')

    # Storage
    flowa_storage_base: str

    # Models
    flowa_convert_model: str
    flowa_extraction_model: str

    # Prompt set
    flowa_prompt_set: str = 'generic'

    # Logging
    flowa_log_level: str = 'INFO'

    # API keys (optional — not all sources/providers need all of these)
    mastermind_api_token: str | None = None
    ncbi_api_key: str | None = None
