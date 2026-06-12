"""Tests for `flowa.aggregate`: the multi-category fan-out orchestration.

The LLM is never called. `_run_category_agent` is mocked at its seam so the
tests exercise *our* orchestration — one subagent dispatched per declared
category, authoritative `category` stamping, manifest-order assembly, the
no-empty-short-circuit behaviour — without re-testing pydantic-ai's
`NativeOutput` / streaming / `ModelRetry` machinery (covered by pydantic-ai).
`query_clinvar` and the citation resolver are mocked too, so no network and no
PDF index loads. The throttle predicate and the multi-category loader get direct
unit tests.

A domain-neutral two-category prompt set lives under
`tests/fixtures/prompt_sets/multi/` (verdict is an opaque string, exercising the
scheme-agnostic contract); `FLOWA_PROMPT_DIR` points the loader at it.
"""

import json
import re
from pathlib import Path

import pytest
from botocore.exceptions import ClientError
from pydantic_ai.models.test import TestModel

import flowa.aggregate as aggregate
from flowa.aggregate import _is_bedrock_throttle, aggregate_evidence_async
from flowa.prompts import load_aggregation
from flowa.settings import ModelConfig
from flowa.storage import assessment_url, encode_doi, paper_url, write_json

FIXTURES = Path(__file__).resolve().parent / 'fixtures' / 'prompt_sets'
MODEL = ModelConfig(name='test-model')  # opaque; create_model is monkeypatched


# --- _is_bedrock_throttle (pure predicate) --------------------------------------


def _client_error(code: str) -> ClientError:
    return ClientError({'Error': {'Code': code, 'Message': 'x'}}, 'Converse')


def test_is_bedrock_throttle_matches_throttling_exception():
    assert _is_bedrock_throttle(_client_error('ThrottlingException')) is True


def test_is_bedrock_throttle_ignores_other_client_errors():
    assert _is_bedrock_throttle(_client_error('ValidationException')) is False


def test_is_bedrock_throttle_ignores_non_client_errors():
    assert _is_bedrock_throttle(ValueError('nope')) is False


# --- load_aggregation with >=2 categories ---------------------------------------


@pytest.fixture
def multi_set(monkeypatch):
    """Point the loader at the synthetic two-category set."""
    monkeypatch.setenv('FLOWA_PROMPT_DIR', str(FIXTURES))
    return 'multi'


def test_load_aggregation_multi_category(multi_set):
    agg = load_aggregation(multi_set)
    assert [c['id'] for c in agg.categories] == ['alpha', 'beta']
    assert set(agg.modules) == {'alpha', 'beta'}
    assert 'CATEGORY ALPHA' in agg.modules['alpha']
    assert 'CATEGORY BETA' in agg.modules['beta']
    assert agg.authoring.strip()
    # The set's CategoryResult subclass carries the base fields plus its verdict.
    fields = agg.category_result.model_fields
    for name in ('category', 'description', 'notes', 'papers', 'claims', 'verdict'):
        assert name in fields


def test_load_aggregation_rejects_non_subclass_schema(tmp_path, monkeypatch):
    """A set whose schema.py defines a CategoryResult not derived from the base
    fails loudly — the fan-out relies on the citation-grounded base fields."""
    agg_dir = tmp_path / 'bad' / 'aggregation' / 'categories'
    agg_dir.mkdir(parents=True)
    (tmp_path / 'bad' / 'aggregation' / 'categories.json').write_text('[{"id": "x", "module": "categories/x.txt"}]')
    (tmp_path / 'bad' / 'aggregation' / 'prompt.txt').write_text('{{ category_id }}')
    (tmp_path / 'bad' / 'aggregation' / 'edit_prompt.txt').write_text('x')
    (tmp_path / 'bad' / 'aggregation' / 'authoring.txt').write_text('x')
    (agg_dir / 'x.txt').write_text('x')
    # A CategoryResult that does NOT subclass flowa.artifact.CategoryResult.
    (tmp_path / 'bad' / 'aggregation' / 'schema.py').write_text(
        'from pydantic import BaseModel\n\n\nclass CategoryResult(BaseModel):\n    foo: str\n'
    )
    monkeypatch.setenv('FLOWA_PROMPT_DIR', str(tmp_path))

    with pytest.raises(TypeError, match='does not subclass'):
        load_aggregation('bad')


# --- fan-out orchestration ------------------------------------------------------


class _FakeRun:
    """Stand-in for pydantic-ai's AgentRunResult: just `.output` + transcript."""

    def __init__(self, output):
        self.output = output

    def all_messages_json(self) -> bytes:
        return b'[]'


def _seed_storage(base: str, variant_id: str, dois: list[str]) -> None:
    """Write the inputs aggregate reads: variant_details, query, and per-paper
    extraction + metadata for each doi."""
    write_json(assessment_url(base, variant_id, 'variant_details.json'), {'gene': 'TEST', 'hgvs': 'c.1A>G'})
    write_json(
        assessment_url(base, variant_id, 'query.json'),
        {
            'dois': dois,
            'variant_spec': {'variants': [{'transcript': 'NM_000000.1', 'hgvs_c': 'c.1A>G'}]},
        },
    )
    for i, doi in enumerate(dois):
        write_json(
            assessment_url(base, variant_id, 'extractions', f'{encode_doi(doi)}.json'),
            {
                'variant_discussed': True,
                'claims': [{'text': f'finding {i}', 'citations': [{'quote': f'quote {i}'}]}],
            },
        )
        write_json(
            paper_url(base, doi, 'metadata.json'),
            {'title': f'Paper {i}', 'authors': f'Author{i}, A', 'date': f'202{i}-01-01', 'pmid': f'{1000 + i}'},
        )


@pytest.fixture
def patched_agent(monkeypatch):
    """Mock the LLM seam: each category subagent returns a CategoryResult whose
    `verdict` echoes the category parsed from its prompt and whose `category` is
    deliberately wrong, so the assembly's authoritative stamping is observable.
    Records the categories dispatched, in call order."""
    monkeypatch.setattr(aggregate, 'create_model', lambda model: TestModel())
    monkeypatch.setattr(aggregate, 'query_clinvar', lambda *a, **k: {})
    monkeypatch.setattr(aggregate, 'format_clinvar_for_prompt', lambda data: 'NO CLINVAR')
    monkeypatch.setattr(aggregate, 'resolve_aggregate_citations', lambda *a, **k: None)

    dispatched: list[str] = []

    async def fake_run(agent, prompt, semaphore):
        match = re.search(r'category `(\w+)`', prompt)
        category = match.group(1)
        dispatched.append(category)
        result = load_aggregation('multi').category_result(
            category='WRONG',  # the engine must override this with the dispatched id
            verdict=f'verdict-for-{category}',
            description=f'desc {category}',
            notes=f'notes {category}',
            papers=[],
            claims=[],
        )
        return _FakeRun(result)

    monkeypatch.setattr(aggregate, '_run_category_agent', fake_run)
    return dispatched


async def test_fanout_dispatches_per_category_and_stamps_in_manifest_order(tmp_path, multi_set, patched_agent):
    base = str(tmp_path)
    _seed_storage(base, 'VAR1', ['10.1/a', '10.2/b'])

    await aggregate_evidence_async(base, 'VAR1', MODEL, prompt_set='multi')

    # One subagent per declared category.
    assert patched_agent == ['alpha', 'beta']

    written = json.loads((tmp_path / 'assessments' / 'VAR1' / 'aggregation.json').read_text())
    results = written['results']
    # Manifest order, with `category` stamped authoritatively (model said WRONG).
    assert [r['category'] for r in results] == ['alpha', 'beta']
    # Each dispatched subagent's output landed in its own slot.
    assert [r['verdict'] for r in results] == ['verdict-for-alpha', 'verdict-for-beta']
    assert written['schema_version'] == aggregate.AGGREGATION_SCHEMA_VERSION


async def test_fanout_raw_transcript_keyed_by_category(tmp_path, multi_set, patched_agent):
    base = str(tmp_path)
    _seed_storage(base, 'VAR1', ['10.1/a'])

    await aggregate_evidence_async(base, 'VAR1', MODEL, prompt_set='multi')

    raw = json.loads((tmp_path / 'assessments' / 'VAR1' / 'aggregation_raw.json').read_text())
    assert set(raw) == {'alpha', 'beta'}


async def test_fanout_no_empty_short_circuit(tmp_path, multi_set, patched_agent):
    """With no papers, every category still runs (each emits its own 'none' via
    the prompt) — there is no engine-level short-circuit."""
    base = str(tmp_path)
    _seed_storage(base, 'VAR1', [])

    await aggregate_evidence_async(base, 'VAR1', MODEL, prompt_set='multi')

    assert patched_agent == ['alpha', 'beta']
    written = json.loads((tmp_path / 'assessments' / 'VAR1' / 'aggregation.json').read_text())
    assert [r['category'] for r in written['results']] == ['alpha', 'beta']
