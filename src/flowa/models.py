"""Model and settings helpers for thinking-enabled LLM providers.

Provider-specific settings types are imported inline because only one
provider is installed at a time (via optional extras).
"""

from typing import Literal

from pydantic_ai.models import Model
from pydantic_ai.settings import ModelSettings

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


def create_model(model_str: str) -> Model | str:
    """Create model with thinking-compatible profile.

    For Bedrock, creates BedrockConverseModel with:
    - tool_choice disabled (required for thinking + structured output)
    - send_back_thinking_parts enabled (required for retries with extended thinking)

    Other providers return the string (pydantic-ai handles them automatically).
    """
    if model_str.startswith('bedrock:'):
        from pydantic_ai.models.bedrock import BedrockConverseModel
        from pydantic_ai.providers.bedrock import BedrockModelProfile

        model_name = model_str.split(':', 1)[1]
        return BedrockConverseModel(
            model_name,
            profile=BedrockModelProfile(
                bedrock_supports_tool_choice=False,
                bedrock_send_back_thinking_parts=True,
            ),
        )
    return model_str


def get_thinking_settings(model_str: str, agent_type: AgentType) -> ModelSettings:
    """Get thinking settings for the specified model provider."""
    max_tokens = _MAX_TOKENS[agent_type]
    effort = _THINKING_EFFORT[agent_type]

    if model_str.startswith('anthropic:'):
        from pydantic_ai.models.anthropic import AnthropicModelSettings

        return AnthropicModelSettings(
            max_tokens=max_tokens,
            anthropic_thinking={'type': 'adaptive'},
            anthropic_effort=effort,
        )
    if model_str.startswith('bedrock:'):
        from pydantic_ai.models.bedrock import BedrockModelSettings

        return BedrockModelSettings(
            max_tokens=max_tokens,
            bedrock_additional_model_requests_fields={
                'thinking': {'type': 'adaptive'},
                'output_config': {'effort': effort},
            },
        )
    if model_str.startswith('google-gla:') or model_str.startswith('google-vertex:'):
        from pydantic_ai.models.google import GoogleModelSettings

        return GoogleModelSettings(
            max_tokens=max_tokens,
            google_thinking_config={'include_thoughts': True},
        )
    if model_str.startswith('openai:'):
        from pydantic_ai.models.openai import OpenAIResponsesModelSettings

        return OpenAIResponsesModelSettings(
            max_tokens=max_tokens,
            openai_reasoning_effort=effort,
            openai_reasoning_summary='detailed',
        )
    # Fallback for unknown providers
    return ModelSettings(max_tokens=max_tokens)
