"""Model and settings helpers for Pydantic AI agents in flowa.

Provider-specific settings types are imported inline because only one
provider is installed at a time (via optional extras).
"""

import logging
import os
from collections.abc import AsyncIterable
from typing import Any

from pydantic import BaseModel
from pydantic_ai import NativeOutput, PromptedOutput, RunContext
from pydantic_ai.models import Model, infer_model_profile
from pydantic_ai.output import OutputSpec
from pydantic_ai.settings import ModelSettings

from flowa.settings import EffortLevel, ModelConfig

log = logging.getLogger(__name__)


def create_model(config: ModelConfig) -> Model | str:
    """Create a pydantic-ai Model for the given config.

    For Bedrock, returns a `BedrockConverseModel` built on our own boto3 client
    (see below); the provider resolves the per-model profile, which
    `structured_output` consults. For other providers, returns the plain model
    string and lets pydantic-ai handle resolution.
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

    ``effort`` is the stage's default thinking level (``None``: request no
    thinking); ``config.effort`` overrides it. A resolved level enables
    adaptive thinking at that effort.
    ``max_tokens`` caps output length when set. Bedrock cost-attribution
    inference profiles flow through whenever set on the config, independent
    of ``effort`` and ``max_tokens``.

    Returns ``None`` when no provider-specific settings are needed.
    """
    effort = config.effort or effort
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
    if config.name.startswith('google:') or config.name.startswith('google-cloud:'):
        if effort is None and max_tokens is None:
            return None
        from pydantic_ai.models.google import GoogleModelSettings

        google_settings: GoogleModelSettings = {}
        if max_tokens is not None:
            google_settings['max_tokens'] = max_tokens
        if effort is not None:
            google_settings['google_thinking_config'] = {'include_thoughts': True}
        return google_settings
    if config.name.startswith('openai:') or config.name.startswith('openai-responses:'):
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


def structured_output[T: BaseModel](model: Model | str, output_type: type[T]) -> OutputSpec[T]:
    """Pick how the agent obtains a validated ``output_type`` from ``model``.

    Where the model profile reports JSON-schema output support, use
    `NativeOutput`: the provider compiles the schema into a grammar and samples
    against it, so the response is schema-valid by construction.

    Otherwise (e.g. Claude Opus 4.7+ on Bedrock, which rejects both
    `output_config.format` and `strict` tools), use `PromptedOutput`: the schema
    goes into the instructions and the model answers with JSON text, which
    pydantic validates, retrying with the errors on failure. Nothing constrains
    the sampling, so validation plus the agent's retries are the safety net.
    `PromptedOutput` rather than a result tool: on Opus 5.5 via Bedrock,
    non-strict tool calls with nested arrays of objects start with a malformed
    call almost every time (an array serialised as a string), while JSON text
    validates on the first attempt.
    """
    profile = model.profile if isinstance(model, Model) else infer_model_profile(model)
    if profile.get('supports_json_schema_output', False):
        return NativeOutput(output_type)
    model_name = model.model_name if isinstance(model, Model) else model
    log.info('%s lacks native structured output; using prompted JSON output', model_name)
    return PromptedOutput(output_type)


async def drain_events(ctx: RunContext[Any], stream: AsyncIterable[Any]) -> None:
    """No-op sink so `agent.run(..., event_stream_handler=...)` streams the model
    request — keeping the connection alive through long extended-thinking while
    the graph still owns the loop, so output retries actually happen: a
    `ModelRetry` from an output validator, or prompted JSON output that fails
    validation. (`agent.run_stream` streams to the caller and can't retry a
    validated output — it raises `UnexpectedModelBehavior` instead.)
    """
    async for _ in stream:
        pass
