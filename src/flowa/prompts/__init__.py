"""Prompt set loading utilities.

Flowa supports configurable prompt sets for different integrations (e.g., the
in-tree ``generic`` set, or a private deployment-specific overlay).
Prompt sets are directories containing prompt templates and Pydantic schema modules.

Resolution order for a given prompt set:

1. External overlay: ``FLOWA_PROMPT_DIR/<set>`` (FLOWA_PROMPT_DIR defaults to
   ``./prompts``, cwd-relative). Use this for deployment-specific sets.
2. Bundled fallback: prompt sets shipped inside the flowa wheel as a sibling
   of this module. Today only ``generic`` ships bundled, so ``pip install
   flowapy`` is self-contained for the in-tree pipeline.

Layout of a prompt set (per-step subdirectories):

    <set>/
        transcription_prompt.txt        # flat; free-form, falls back to generic
        extraction/
            prompt.txt
            schema.py                   # defines ExtractionResult
        aggregation/
            categories.json             # ordered [{id, module}, ...] manifest
            prompt.txt                  # genesis template (framing + injected slots)
            edit_prompt.txt             # edit template (consumed by @flowajs/chat-service)
            edit_schema.ts              # Zod schema (consumed by @flowajs/chat-service)
            schema.py                   # defines CategoryResult
            authoring.txt               # shared write-up guidance, injected into both templates
            categories/<id>.txt         # per-category domain module, injected per category

``transcription_prompt.txt`` is loaded via :func:`load_text_prompt` and falls back to the
generic set when absent. Aggregation fans out one subagent per manifest entry; each emits a
single ``CategoryResult`` and flowa assembles the top-level artifact itself, so there is no
``AggregationResult`` list-wrapper.

Schema interface requirements (accessed by Flowa's validation logic):
    - ExtractionResult.claims[].citations[].quote
    - CategoryResult.papers[].paper_id
    - CategoryResult.claims[].paper_id and .citations[].quote
"""

import importlib.util
import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path

import jinja2
from pydantic import BaseModel

from flowa.artifact import CategoryResult

log = logging.getLogger(__name__)

# Plain-text prompts; missing context vars should raise loudly rather than render empty.
_jinja_env = jinja2.Environment(
    undefined=jinja2.StrictUndefined,
    autoescape=False,
    keep_trailing_newline=True,
)

# Root for bundled prompt sets — populated by the wheel's hatch force-include
# rule (see pyproject.toml [tool.hatch.build.targets.wheel.force-include]).
# Exposed so tests can monkeypatch it to a fixture location, since the source
# tree only carries `prompts/generic/` at the repo root, not as a sibling of
# this module.
_BUNDLED_ROOT = Path(__file__).parent


def _prompts_dir(prompt_set: str) -> Path:
    """Resolve a prompt-set directory.

    Checks the external overlay first (``FLOWA_PROMPT_DIR/<set>``, defaulting
    to ``./prompts/<set>``), then falls back to a set bundled inside the flowa
    package. Deployment-specific sets (e.g. private curated overlays) come via
    the external overlay; today only ``generic`` ships bundled.
    """
    prompts_root = Path(os.environ.get('FLOWA_PROMPT_DIR', 'prompts'))
    external = prompts_root / prompt_set
    if external.exists():
        return external

    bundled = _BUNDLED_ROOT / prompt_set
    if bundled.is_dir():
        return bundled

    external_available = [p.name for p in prompts_root.iterdir() if p.is_dir()] if prompts_root.exists() else []
    bundled_available = [p.name for p in _BUNDLED_ROOT.iterdir() if p.is_dir() and p.name != '__pycache__']
    raise ValueError(
        f"Prompt set '{prompt_set}' not found. "
        f'External overlay searched at {external} (set FLOWA_PROMPT_DIR to override); '
        f'bundled fallback searched at {bundled}. '
        f'External available: {external_available}; bundled available: {bundled_available}.'
    )


def _load_model_from_module(module_path: Path, class_name: str, module_key: str) -> type[BaseModel]:
    """Import a schema module by path and return one of its model classes."""
    spec = importlib.util.spec_from_file_location(module_key, module_path)
    if spec is None or spec.loader is None:
        raise ImportError(f'Could not load module from {module_path}')

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    if not hasattr(module, class_name):
        raise AttributeError(f"Module {module_path} does not define '{class_name}'")

    return getattr(module, class_name)


def load_text_prompt(step: str, prompt_set: str = 'generic') -> str:
    """Load a prompt as plain text, falling back to the generic set if absent.

    If the active prompt set has its own ``{step}_prompt.txt``, that file is
    used. Otherwise the file from the generic set is returned, so step-agnostic
    prompts (currently transcription) don't have to be duplicated into every
    prompt set.

    Use for steps whose output isn't a Pydantic-validated structure. For prompts
    that pair with a result schema, use ``load_prompt_and_schema`` (extraction) or
    ``load_aggregation`` (aggregation) instead — no fallback there because the prompt
    and schema must come from the same set.
    """
    filename = f'{step}_prompt.txt'
    candidate = _prompts_dir(prompt_set) / filename
    if candidate.exists():
        log.info('Loaded %s/%s', prompt_set, filename)
        return candidate.read_text()
    log.info("Prompt set '%s' has no %s; loaded from generic instead", prompt_set, filename)
    return (_prompts_dir('generic') / filename).read_text()


def load_prompt_and_schema(step: str, prompt_set: str = 'generic') -> tuple[jinja2.Template, type[BaseModel]]:
    """Load a Jinja-templated prompt together with its result schema.

    Use for a step whose output is a single Pydantic-validated structure (extraction).
    The files live under ``<set>/<step>/`` as ``prompt.txt`` + ``schema.py``, and the
    schema module must define ``{step.title()}Result`` (e.g. ``ExtractionResult``).
    Aggregation uses :func:`load_aggregation` instead (manifest-driven fan-out).

    Returns:
        Tuple of (compiled Jinja2 template, result_model_class).
    """
    step_dir = _prompts_dir(prompt_set) / step

    template = _jinja_env.from_string((step_dir / 'prompt.txt').read_text())
    class_name = f'{step.title()}Result'
    model = _load_model_from_module(step_dir / 'schema.py', class_name, f'{prompt_set}_{step}_schema')
    log.info('Loaded %s/%s/prompt.txt + schema.py (%s)', prompt_set, step, class_name)
    return template, model


@dataclass(frozen=True)
class AggregationPromptSet:
    """Everything the aggregate fan-out needs from a prompt set.

    ``categories`` is the ordered manifest (``[{id, module}, ...]``); ``modules`` maps each
    category id to its rendered domain-module text; ``authoring`` is the shared write-up
    guidance injected into every category's prompt; ``category_result`` is the set's
    ``CategoryResult`` subclass used as the per-subagent ``NativeOutput`` type.
    """

    template: jinja2.Template
    categories: list[dict[str, str]]
    authoring: str
    modules: dict[str, str]
    category_result: type[CategoryResult]


def load_aggregation(prompt_set: str = 'generic') -> AggregationPromptSet:
    """Load the aggregation manifest, templates, modules, and result schema for a set.

    flowa fans out one subagent per manifest entry, rendering ``aggregation/prompt.txt``
    with the shared ``authoring`` and that category's ``module`` injected as values. The
    set's ``CategoryResult`` is the per-subagent output type; flowa stamps ``category`` and
    assembles the top-level artifact itself.
    """
    agg_dir = _prompts_dir(prompt_set) / 'aggregation'

    template = _jinja_env.from_string((agg_dir / 'prompt.txt').read_text())
    categories: list[dict[str, str]] = json.loads((agg_dir / 'categories.json').read_text())
    authoring = (agg_dir / 'authoring.txt').read_text()
    modules = {entry['id']: (agg_dir / entry['module']).read_text() for entry in categories}
    category_result = _load_model_from_module(
        agg_dir / 'schema.py', 'CategoryResult', f'{prompt_set}_aggregation_schema'
    )
    if not issubclass(category_result, CategoryResult):
        raise TypeError(
            f"{prompt_set}'s aggregation/schema.py defines a CategoryResult that does not subclass "
            f'flowa.artifact.CategoryResult; the fan-out relies on the citation-grounded base fields.'
        )

    log.info(
        'Loaded %s/aggregation: %d categories (%s)', prompt_set, len(categories), ', '.join(m['id'] for m in categories)
    )
    return AggregationPromptSet(
        template=template,
        categories=categories,
        authoring=authoring,
        modules=modules,
        category_result=category_result,
    )
