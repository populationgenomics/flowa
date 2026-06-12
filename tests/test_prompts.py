"""Smoke tests for prompt template loading and rendering.

Catches the bug class that bit us pre-Jinja2: literal `{` `}` in prompt
content collide with the templating engine. Each test renders a prompt
with stub values and asserts the stubs land in the output, plus that
no Jinja2 markers leak through.
"""

from pathlib import Path

import jinja2
import pytest

from flowa.prompts import load_aggregation, load_prompt_and_schema, load_text_prompt

# Ensure cwd-relative `prompts/` resolution lands at the repo root.
REPO_ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(autouse=True)
def _chdir_repo_root(monkeypatch):
    # Resolve against the in-repo `prompts/` (cwd-relative default), independent of any
    # ambient FLOWA_PROMPT_DIR/FLOWA_PROMPT_SET a developer shell may export.
    monkeypatch.delenv('FLOWA_PROMPT_DIR', raising=False)
    monkeypatch.delenv('FLOWA_PROMPT_SET', raising=False)
    monkeypatch.chdir(REPO_ROOT)


def test_load_extraction_prompt_renders():
    template, output_type = load_prompt_and_schema('extraction', 'generic')

    rendered = template.render(
        variant_details='STUB_VARIANT_DETAILS',
        full_text='STUB_FULL_TEXT',
    )

    assert 'STUB_VARIANT_DETAILS' in rendered
    assert 'STUB_FULL_TEXT' in rendered
    # Loose check that the schema model loaded.
    assert hasattr(output_type, 'model_fields')
    # No leaked Jinja2 placeholders.
    assert '{{ variant_details }}' not in rendered
    assert '{{ full_text }}' not in rendered


def test_load_aggregation_manifest_and_modules():
    agg = load_aggregation('generic')

    # The generic set declares a single label-based category.
    assert agg.categories == [{'id': 'acmg_classification', 'module': 'categories/acmg_classification.txt'}]
    assert set(agg.modules) == {'acmg_classification'}
    assert agg.authoring.strip()
    assert agg.modules['acmg_classification'].strip()

    # The output model is the set's CategoryResult subclass.
    fields = agg.category_result.model_fields
    for name in ('category', 'description', 'notes', 'papers', 'claims', 'classification', 'classification_rationale'):
        assert name in fields, f'CategoryResult missing field {name!r}'


def test_aggregation_prompt_renders_with_injected_slots():
    agg = load_aggregation('generic')

    rendered = agg.template.render(
        variant_details='STUB_VARIANT_DETAILS',
        clinvar_data='STUB_CLINVAR_DATA',
        evidence_extractions='STUB_EVIDENCE_EXTRACTIONS',
        authoring='STUB_AUTHORING',
        category_module='STUB_CATEGORY_MODULE',
        category_id='acmg_classification',
    )

    for stub in (
        'STUB_VARIANT_DETAILS',
        'STUB_CLINVAR_DATA',
        'STUB_EVIDENCE_EXTRACTIONS',
        'STUB_AUTHORING',
        'STUB_CATEGORY_MODULE',
        'acmg_classification',
    ):
        assert stub in rendered

    for marker in ('{{ authoring }}', '{{ category_module }}', '{{ category_id }}', '{{ evidence_extractions }}'):
        assert marker not in rendered


def test_aggregation_prompt_strict_undefined():
    """Missing context vars must raise rather than silently render empty."""
    agg = load_aggregation('generic')

    with pytest.raises(jinja2.UndefinedError):
        agg.template.render(variant_details='only this one provided')


def test_load_text_prompt_uses_active_set_when_present(tmp_path, monkeypatch):
    """If the active set has the file, use it (no fallback)."""
    (tmp_path / 'custom').mkdir()
    (tmp_path / 'custom' / 'transcription_prompt.txt').write_text('CUSTOM')
    (tmp_path / 'generic').mkdir()
    (tmp_path / 'generic' / 'transcription_prompt.txt').write_text('GENERIC')

    monkeypatch.setenv('FLOWA_PROMPT_DIR', str(tmp_path))

    assert load_text_prompt('transcription', 'custom') == 'CUSTOM'


def test_load_text_prompt_falls_back_to_generic(tmp_path, monkeypatch):
    """If the active set lacks the file, fall back to generic."""
    (tmp_path / 'custom').mkdir()
    (tmp_path / 'generic').mkdir()
    (tmp_path / 'generic' / 'transcription_prompt.txt').write_text('GENERIC')

    monkeypatch.setenv('FLOWA_PROMPT_DIR', str(tmp_path))

    assert load_text_prompt('transcription', 'custom') == 'GENERIC'


def test_external_overlay_misses_then_bundled_fallback_resolves(tmp_path, monkeypatch):
    """When FLOWA_PROMPT_DIR carries no matching set, the bundled fallback is used."""
    overlay = tmp_path / 'overlay'
    overlay.mkdir()
    monkeypatch.setenv('FLOWA_PROMPT_DIR', str(overlay))

    bundled_root = tmp_path / 'bundled'
    bundled_root.mkdir()
    (bundled_root / 'generic').mkdir()
    (bundled_root / 'generic' / 'transcription_prompt.txt').write_text('BUNDLED-GENERIC')

    import flowa.prompts as flowa_prompts

    monkeypatch.setattr(flowa_prompts, '_BUNDLED_ROOT', bundled_root)

    assert load_text_prompt('transcription', 'generic') == 'BUNDLED-GENERIC'


def test_missing_in_both_overlay_and_bundled_raises(tmp_path, monkeypatch):
    """Error message names both search locations + what was actually available."""
    overlay = tmp_path / 'overlay'
    overlay.mkdir()
    (overlay / 'set_a').mkdir()
    monkeypatch.setenv('FLOWA_PROMPT_DIR', str(overlay))

    bundled_root = tmp_path / 'bundled'
    bundled_root.mkdir()
    (bundled_root / 'set_b').mkdir()

    import flowa.prompts as flowa_prompts

    monkeypatch.setattr(flowa_prompts, '_BUNDLED_ROOT', bundled_root)

    with pytest.raises(ValueError) as exc:
        load_text_prompt('transcription', 'set_missing')

    msg = str(exc.value)
    assert "'set_missing'" in msg
    assert 'set_a' in msg
    assert 'set_b' in msg
