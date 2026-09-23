"""Tests for `flowa.models`.

`structured_output` is tested on two layers: which output mode is chosen for
the models we deploy (a canary on pydantic-ai's per-model profiles, which
encode what each provider supports), and how the prompted-JSON fallback
handles fenced or invalid JSON. `get_model_settings` is tested for the
per-stage effort override.
"""

import pytest
from pydantic import BaseModel
from pydantic_ai import Agent, NativeOutput, PromptedOutput
from pydantic_ai.messages import ModelMessage, ModelResponse, RetryPromptPart, TextPart
from pydantic_ai.models.bedrock import BedrockConverseModel
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.profiles import ModelProfile
from pydantic_ai.providers.bedrock import BedrockProvider

from flowa.models import get_model_settings, structured_output
from flowa.settings import ModelConfig


class Finding(BaseModel):
    gene: str
    count: int


def _bedrock(model_id: str) -> BedrockConverseModel:
    return BedrockConverseModel(model_id, provider=BedrockProvider(region_name='ap-southeast-2'))


# --- mode selection ------------------------------------------------------------


@pytest.mark.parametrize(
    'model',
    [
        pytest.param(lambda: _bedrock('au.anthropic.claude-sonnet-4-6'), id='bedrock-sonnet-4-6'),
        pytest.param(lambda: _bedrock('au.anthropic.claude-opus-4-6-v1'), id='bedrock-opus-4-6'),
        pytest.param(lambda: 'anthropic:claude-opus-5-5', id='anthropic-opus-5-5'),
    ],
)
def test_native_output_where_supported(model):
    assert isinstance(structured_output(model(), Finding), NativeOutput)


@pytest.mark.parametrize(
    'model_id',
    ['au.anthropic.claude-opus-5-5', 'global.anthropic.claude-opus-4-8', 'au.anthropic.claude-sonnet-5'],
)
def test_prompted_output_on_bedrock_without_structured_output(model_id):
    assert isinstance(structured_output(_bedrock(model_id), Finding), PromptedOutput)


# --- prompted-output behaviour ------------------------------------------------

_NO_NATIVE = ModelProfile(supports_json_schema_output=False)


def _retry_prompts(messages: list[ModelMessage]) -> list[str]:
    return [
        part.model_response()
        for message in messages
        for part in getattr(message, 'parts', [])
        if isinstance(part, RetryPromptPart)
    ]


def _scripted(*replies: str) -> FunctionModel:
    """A model that replays text ``replies`` in order and checks it was sent the schema, not a tool."""
    queue = list(replies)

    def respond(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        assert not info.output_tools
        assert info.instructions and '"count"' in info.instructions
        return ModelResponse(parts=[TextPart(queue.pop(0))])

    return FunctionModel(respond, profile=_NO_NATIVE)


def _agent(model: FunctionModel) -> Agent[None, Finding]:
    return Agent(model, output_type=structured_output(model, Finding), retries=3)


async def test_json_text_is_validated_output():
    result = await _agent(_scripted('{"gene": "TP53", "count": 3}')).run('go')

    assert result.output == Finding(gene='TP53', count=3)


async def test_fenced_json_is_accepted():
    result = await _agent(_scripted('```json\n{"gene": "TP53", "count": 3}\n```')).run('go')

    assert result.output == Finding(gene='TP53', count=3)


async def test_invalid_json_is_retried_with_the_validation_error():
    model = _scripted('{"gene": "TP53", "integer": 3}', '{"gene": "TP53", "count": 3}')

    result = await _agent(model).run('go')

    assert result.output == Finding(gene='TP53', count=3)
    [retry] = _retry_prompts(result.all_messages())
    assert 'count' in retry


# --- per-stage effort override -------------------------------------------------


def _bedrock_fields(config: ModelConfig, effort=None):
    settings = get_model_settings(config, effort=effort) or {}
    return settings.get('bedrock_additional_model_requests_fields')


def test_stage_default_effort_applies_when_config_is_unset():
    config = ModelConfig(name='bedrock:au.anthropic.claude-sonnet-4-6')
    assert _bedrock_fields(config, effort='medium') == {
        'thinking': {'type': 'adaptive'},
        'output_config': {'effort': 'medium'},
    }
    assert _bedrock_fields(config) is None


def test_config_effort_overrides_stage_default():
    config = ModelConfig(name='bedrock:au.anthropic.claude-opus-5-5', effort='low')
    assert _bedrock_fields(config, effort='medium') == {
        'thinking': {'type': 'adaptive'},
        'output_config': {'effort': 'low'},
    }
    assert _bedrock_fields(config) == {'thinking': {'type': 'adaptive'}, 'output_config': {'effort': 'low'}}
