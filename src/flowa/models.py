"""Model and settings helpers for thinking-enabled LLM providers."""

from typing import Literal

from pydantic_ai.models import Model
from pydantic_ai.models.anthropic import AnthropicModelSettings
from pydantic_ai.models.bedrock import BedrockModelSettings
from pydantic_ai.models.google import GoogleModelSettings
from pydantic_ai.models.openai import OpenAIResponsesModelSettings
from pydantic_ai.settings import ModelSettings

AgentType = Literal['extraction', 'aggregation']

_THINKING_BUDGETS: dict[AgentType, int] = {
    'extraction': 10_000,
    'aggregation': 20_000,
}

_MAX_TOKENS: dict[AgentType, int] = {
    'extraction': 30_000,
    'aggregation': 60_000,
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
    budget = _THINKING_BUDGETS[agent_type]
    max_tokens = _MAX_TOKENS[agent_type]

    if model_str.startswith('anthropic:'):
        return AnthropicModelSettings(
            max_tokens=max_tokens,
            anthropic_thinking={'type': 'enabled', 'budget_tokens': budget},
        )
    if model_str.startswith('bedrock:'):
        return BedrockModelSettings(
            max_tokens=max_tokens,
            bedrock_additional_model_requests_fields={'thinking': {'type': 'enabled', 'budget_tokens': budget}},
        )
    if model_str.startswith('google-gla:') or model_str.startswith('google-vertex:'):
        return GoogleModelSettings(
            max_tokens=max_tokens,
            google_thinking_config={'include_thoughts': True},
        )
    if model_str.startswith('openai:'):
        return OpenAIResponsesModelSettings(
            max_tokens=max_tokens,
            openai_reasoning_effort='high',
            openai_reasoning_summary='detailed',
        )
    # Fallback for unknown providers
    return ModelSettings(max_tokens=max_tokens)
