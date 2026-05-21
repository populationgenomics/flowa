"""Prompt set loading utilities.

Flowa supports configurable prompt sets for different integrations (e.g., the
in-tree `generic` set, or a private deployment-specific overlay).
Prompt sets are directories under `prompts/` containing prompt templates and Pydantic schema modules.

Configuration:
    FLOWA_PROMPT_SET: Name of the prompt set directory to use (default: 'generic')
    FLOWA_PROMPT_DIR: Path to the directory holding prompt-set subdirectories.
        Defaults to `./prompts` (cwd-relative) — fine for `flowa <command>`
        invoked from the repo root, but external consumers running flowa
        from a different cwd should set this explicitly.

Each prompt set must contain:
    - extraction_prompt.txt
    - extraction_schema.py     (must define ExtractionResult model)
    - aggregation_prompt.txt
    - aggregation_schema.py    (must define AggregationResult model)

Text-only prompts (loaded via load_text_prompt, e.g. transcription_prompt.txt)
are optional in the active set: if absent, they're resolved from the generic
set. Override only when a step needs domain-specific wording — transcription
is a faithful PDF→Markdown task with no domain content, so most sets share
the generic prompt.

Schema interface requirements (accessed by Flowa's validation logic):
    - ExtractionResult.claims[].citations[].quote
    - AggregationResult.results[].papers[].paper_id
    - AggregationResult.results[].claims[].paper_id and .citations[].quote
"""

import importlib.util
import logging
import os
from pathlib import Path
from typing import TYPE_CHECKING

import jinja2

if TYPE_CHECKING:
    from pydantic import BaseModel

log = logging.getLogger(__name__)

# Plain-text prompts; missing context vars should raise loudly rather than render empty.
_jinja_env = jinja2.Environment(
    undefined=jinja2.StrictUndefined,
    autoescape=False,
    keep_trailing_newline=True,
)


def _prompts_dir(prompt_set: str) -> Path:
    """Resolve and validate the prompt-set directory."""
    prompts_root = Path(os.environ.get('FLOWA_PROMPT_DIR', 'prompts'))
    prompts_dir = prompts_root / prompt_set

    if not prompts_dir.exists():
        available = [p.name for p in prompts_root.iterdir() if p.is_dir()] if prompts_root.exists() else []
        raise ValueError(f"Prompt set '{prompt_set}' not found at {prompts_dir}. Available: {available}")

    return prompts_dir


def load_text_prompt(step: str, prompt_set: str = 'generic') -> str:
    """Load a prompt as plain text, falling back to the generic set if absent.

    If the active prompt set has its own ``{step}_prompt.txt``, that file is
    used. Otherwise the file from the generic set is returned, so step-agnostic
    prompts (currently transcription) don't have to be duplicated into every
    prompt set.

    Use for steps whose output isn't a Pydantic-validated structure. For prompts
    that pair with a result schema (extraction, aggregation), use
    ``load_prompt_and_schema`` instead — no fallback there because the prompt
    and schema must come from the same set.
    """
    filename = f'{step}_prompt.txt'
    candidate = _prompts_dir(prompt_set) / filename
    if candidate.exists():
        log.info('Loaded %s/%s', prompt_set, filename)
        return candidate.read_text()
    log.info("Prompt set '%s' has no %s; loaded from generic instead", prompt_set, filename)
    return (_prompts_dir('generic') / filename).read_text()


def load_prompt_and_schema(step: str, prompt_set: str = 'generic') -> tuple[jinja2.Template, 'type[BaseModel]']:
    """Load a Jinja-templated prompt together with its result schema.

    Use for steps whose output is a Pydantic-validated structure (extraction,
    aggregation). For free-form text prompts, use ``load_text_prompt`` instead.

    Args:
        step: Pipeline step name (e.g. 'extraction', 'aggregation').
        prompt_set: Name of the prompt set directory under prompts/.

    Returns:
        Tuple of (compiled Jinja2 template, result_model_class). Render the template
        with `template.render(**kwargs)`.

    Raises:
        ValueError: If the prompt set directory does not exist.
    """
    prompts_dir = _prompts_dir(prompt_set)

    # Load and compile prompt template
    prompt_text = (prompts_dir / f'{step}_prompt.txt').read_text()
    template = _jinja_env.from_string(prompt_text)
    log.info('Loaded %s/%s_prompt.txt + %s_schema.py', prompt_set, step, step)

    # Load schema model
    module_path = prompts_dir / f'{step}_schema.py'
    class_name = f'{step.title()}Result'

    spec = importlib.util.spec_from_file_location(f'{prompt_set}_{step}_schema', module_path)
    if spec is None or spec.loader is None:
        raise ImportError(f'Could not load module from {module_path}')

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    if not hasattr(module, class_name):
        raise AttributeError(f"Module {module_path} does not define '{class_name}'")

    return template, getattr(module, class_name)
