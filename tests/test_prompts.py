"""Smoke tests for prompt template loading and rendering.

Catches the bug class that bit us pre-Jinja2: literal `{` `}` in prompt
content collide with the templating engine. Each test renders a prompt
with stub values and asserts the stubs land in the output, plus that
no Jinja2 markers leak through.
"""

from pathlib import Path

import jinja2
import pytest

from flowa.prompts import load_prompt

# Ensure cwd-relative `prompts/` resolution in `load_prompt` lands at the repo root.
REPO_ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(autouse=True)
def _chdir_repo_root(monkeypatch):
    monkeypatch.chdir(REPO_ROOT)


def test_load_extraction_prompt_renders():
    template, output_type = load_prompt('extraction', 'generic')

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


def test_load_aggregate_prompt_renders():
    template, output_type = load_prompt('aggregate', 'generic')

    rendered = template.render(
        variant_details='STUB_VARIANT_DETAILS',
        clinvar_data='STUB_CLINVAR_DATA',
        evidence_extractions='STUB_EVIDENCE_EXTRACTIONS',
    )

    assert 'STUB_VARIANT_DETAILS' in rendered
    assert 'STUB_CLINVAR_DATA' in rendered
    assert 'STUB_EVIDENCE_EXTRACTIONS' in rendered
    assert hasattr(output_type, 'model_fields')
    assert '{{ variant_details }}' not in rendered
    assert '{{ clinvar_data }}' not in rendered
    assert '{{ evidence_extractions }}' not in rendered


def test_aggregate_prompt_strict_undefined():
    """Missing context vars must raise rather than silently render empty."""
    template, _ = load_prompt('aggregate', 'generic')

    with pytest.raises(jinja2.UndefinedError):
        template.render(variant_details='only this one provided')
