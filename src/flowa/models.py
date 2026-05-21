"""Model and settings helpers for Pydantic AI agents in flowa.

Provider-specific settings types are imported inline because only one
provider is installed at a time (via optional extras).
"""

import os
from typing import Literal

from pydantic_ai.models import Model
from pydantic_ai.settings import ModelSettings

from flowa.settings import ModelConfig

EffortLevel = Literal['low', 'medium', 'high']


def create_model(config: ModelConfig) -> Model | str:
    """Create a pydantic-ai Model for the given config.

    For Bedrock, returns a `BedrockConverseModel` so the provider can resolve
    the per-model profile (which carries `supports_json_schema_output=True` for
    Claude 4.5+ and the `BedrockJsonSchemaTransformer`, both required for
    constrained sampling via `NativeOutput`). For other providers, returns the
    plain model string and lets pydantic-ai handle resolution.
    """
    if config.name.startswith('bedrock:'):
        import boto3
        from botocore.config import Config
        from pydantic_ai.models.bedrock import BedrockConverseModel
        from pydantic_ai.providers.bedrock import BedrockProvider

        if os.getenv('AWS_BEARER_TOKEN_BEDROCK'):
            # pydantic-ai's default BedrockProvider builds a bearer-auth session
            # in this case. We construct our own client below to control retry
            # config, which means we'd silently fall through to IAM auth here.
            # Flag rather than fail confusingly.
            raise NotImplementedError(
                'AWS_BEARER_TOKEN_BEDROCK is set but flowa.models.create_model '
                'currently only constructs IAM-auth Bedrock clients. Either unset '
                'the env var or extend create_model to build a bearer-auth session.'
            )

        # We construct the bedrock-runtime client ourselves (rather than letting
        # BedrockProvider build its default) to override two boto3/pydantic-ai
        # defaults that bite on extended-thinking LLM calls:
        #
        #   1. read_timeout: pydantic-ai's default of 300s is far too short for
        #      Sonnet-class extended-thinking calls, which can generate tens of
        #      thousands of internal thinking tokens before any byte arrives
        #      back. AWS_READ_TIMEOUT still overrides this default.
        #
        #   2. retry max_attempts: boto3 defaults to 3 attempts with silent
        #      retries on read_timeout — a single 20-min hang becomes 60 min,
        #      and CloudWatch only records the final attempt, so the retries
        #      are invisible. Pin to 1 so failures surface as errors instead
        #      of getting masked. This relies on callers using streaming
        #      (see aggregate / extract / convert), which keeps bytes flowing
        #      so legitimate long thinking doesn't trip read_timeout in the
        #      first place. Throttle / 5xx still need caller-level retry
        #      handling — currently they propagate.
        #
        # Everything else matches pydantic-ai's defaults: connect_timeout=60s
        # (also via AWS_CONNECT_TIMEOUT env), and region / profile / credentials
        # come from boto3's default session (AWS_REGION, AWS_PROFILE, etc.).
        read_timeout = float(os.getenv('AWS_READ_TIMEOUT', '1200'))
        connect_timeout = float(os.getenv('AWS_CONNECT_TIMEOUT', '60'))
        bedrock_client = boto3.client(
            'bedrock-runtime',
            config=Config(
                read_timeout=read_timeout,
                connect_timeout=connect_timeout,
                retries={'max_attempts': 1, 'mode': 'standard'},
            ),
        )
        return BedrockConverseModel(
            config.name.removeprefix('bedrock:'),
            provider=BedrockProvider(bedrock_client=bedrock_client),
        )
    return config.name


def get_model_settings(
    config: ModelConfig,
    *,
    effort: EffortLevel | None = None,
    max_tokens: int | None = None,
) -> ModelSettings | None:
    """Build provider-specific ModelSettings.

    ``effort`` enables extended thinking at the given level when set.
    ``max_tokens`` caps output length when set. Bedrock cost-attribution
    inference profiles flow through whenever set on the config, independent
    of ``effort`` and ``max_tokens``.

    Returns ``None`` when no provider-specific settings are needed.
    """
    if config.name.startswith('anthropic:'):
        if effort is None and max_tokens is None:
            return None
        from pydantic_ai.models.anthropic import AnthropicModelSettings

        settings: AnthropicModelSettings = {}
        if max_tokens is not None:
            settings['max_tokens'] = max_tokens
        if effort is not None:
            settings['anthropic_thinking'] = {'type': 'adaptive'}
            settings['anthropic_effort'] = effort
        return settings
    if config.name.startswith('bedrock:'):
        from pydantic_ai.models.bedrock import BedrockModelSettings

        bedrock_settings: BedrockModelSettings = {}
        if max_tokens is not None:
            bedrock_settings['max_tokens'] = max_tokens
        if effort is not None:
            bedrock_settings['bedrock_additional_model_requests_fields'] = {
                'thinking': {'type': 'adaptive'},
                'output_config': {'effort': effort},
            }
        if config.bedrock_inference_profile:
            bedrock_settings['bedrock_inference_profile'] = config.bedrock_inference_profile
        return bedrock_settings if bedrock_settings else None
    if config.name.startswith('google-gla:') or config.name.startswith('google-vertex:'):
        if effort is None and max_tokens is None:
            return None
        from pydantic_ai.models.google import GoogleModelSettings

        google_settings: GoogleModelSettings = {}
        if max_tokens is not None:
            google_settings['max_tokens'] = max_tokens
        if effort is not None:
            google_settings['google_thinking_config'] = {'include_thoughts': True}
        return google_settings
    if config.name.startswith('openai:'):
        if effort is None and max_tokens is None:
            return None
        from pydantic_ai.models.openai import OpenAIResponsesModelSettings

        openai_settings: OpenAIResponsesModelSettings = {}
        if max_tokens is not None:
            openai_settings['max_tokens'] = max_tokens
        if effort is not None:
            openai_settings['openai_reasoning_effort'] = effort
            openai_settings['openai_reasoning_summary'] = 'detailed'
        return openai_settings
    # Unknown provider fallback
    if max_tokens is None:
        return None
    return ModelSettings(max_tokens=max_tokens)
