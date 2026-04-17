"""Model and settings helpers for thinking-enabled LLM providers.

Provider-specific settings types are imported inline because only one
provider is installed at a time (via optional extras).
"""

from typing import Literal

from pydantic_ai.models import Model
from pydantic_ai.settings import ModelSettings

from flowa.settings import ModelConfig

AgentType = Literal['extraction', 'aggregation']
EffortLevel = Literal['low', 'medium', 'high']

_MAX_TOKENS: dict[AgentType, int] = {
    'extraction': 80_000,
    'aggregation': 80_000,
}

_THINKING_EFFORT: dict[AgentType, EffortLevel] = {
    'extraction': 'medium',
    'aggregation': 'high',
}


def create_model(config: ModelConfig) -> Model | str:
    """Create a pydantic-ai Model for the given config.

    For Bedrock, returns a `BedrockConverseModel` so the provider can resolve
    the per-model profile (which carries `supports_json_schema_output=True` for
    Claude 4.5+ and the `BedrockJsonSchemaTransformer`, both required for
    constrained sampling via `NativeOutput`). For other providers, returns the
    plain model string and lets pydantic-ai handle resolution.
    """
    if config.name.startswith('bedrock:'):
        from pydantic_ai.models.bedrock import BedrockConverseModel

        return BedrockConverseModel(config.name.removeprefix('bedrock:'))
    return config.name


def get_thinking_settings(config: ModelConfig, agent_type: AgentType) -> ModelSettings:
    """Get thinking settings for the specified model provider."""
    max_tokens = _MAX_TOKENS[agent_type]
    effort = _THINKING_EFFORT[agent_type]

    if config.name.startswith('anthropic:'):
        from pydantic_ai.models.anthropic import AnthropicModelSettings

        return AnthropicModelSettings(
            max_tokens=max_tokens,
            anthropic_thinking={'type': 'adaptive'},
            anthropic_effort=effort,
        )
    if config.name.startswith('bedrock:'):
        from pydantic_ai.models.bedrock import BedrockModelSettings

        settings: BedrockModelSettings = {
            'max_tokens': max_tokens,
            'bedrock_additional_model_requests_fields': {
                'thinking': {'type': 'adaptive'},
                'output_config': {'effort': effort},
            },
        }
        if config.bedrock_inference_profile:
            settings['bedrock_inference_profile'] = config.bedrock_inference_profile
        return settings
    if config.name.startswith('google-gla:') or config.name.startswith('google-vertex:'):
        from pydantic_ai.models.google import GoogleModelSettings

        return GoogleModelSettings(
            max_tokens=max_tokens,
            google_thinking_config={'include_thoughts': True},
        )
    if config.name.startswith('openai:'):
        from pydantic_ai.models.openai import OpenAIResponsesModelSettings

        return OpenAIResponsesModelSettings(
            max_tokens=max_tokens,
            openai_reasoning_effort=effort,
            openai_reasoning_summary='detailed',
        )
    # Fallback for unknown providers
    return ModelSettings(max_tokens=max_tokens)
