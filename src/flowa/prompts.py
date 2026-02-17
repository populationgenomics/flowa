"""Prompt set loading utilities.

Flowa supports configurable prompt sets for different integrations (e.g., Curio, generic ACMG).
Prompt sets are directories under `prompts/` containing prompt templates and Pydantic schema modules.

Configuration:
    FLOWA_PROMPT_SET: Name of the prompt set directory to use (default: 'generic')

Each prompt set must contain:
    - extraction_prompt.txt
    - extraction_schema.py   (must define ExtractionResult model)
    - aggregate_prompt.txt
    - aggregate_schema.py    (must define AggregateResult model)

Schema interface requirements (accessed by Flowa's validation logic):
    - ExtractionResult.evidence[].citations[].box_id
    - AggregateResult.citations[].pmid and .box_id
"""

import importlib.util
import logging
import os
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pydantic import BaseModel

log = logging.getLogger(__name__)


def load_prompt(step: str) -> tuple[str, 'type[BaseModel]']:
    """Load prompt template and schema model for a pipeline step.

    Resolves the prompt set directory from FLOWA_PROMPT_SET (default: 'generic'),
    then loads ``{step}_prompt.txt`` and the ``{Step}Result`` class from
    ``{step}_schema.py``.

    Args:
        step: Pipeline step name (e.g. 'extraction', 'aggregate').

    Returns:
        Tuple of (prompt_template, result_model_class).

    Raises:
        ValueError: If the prompt set directory does not exist.
    """
    prompt_set = os.environ.get('FLOWA_PROMPT_SET') or 'generic'
    prompts_dir = Path('prompts') / prompt_set

    if not prompts_dir.exists():
        available = [p.name for p in Path('prompts').iterdir() if p.is_dir()]
        raise ValueError(f"Prompt set '{prompt_set}' not found at {prompts_dir}. Available: {available}")

    log.info('Using prompt set: %s', prompt_set)

    # Load prompt template
    prompt_text = (prompts_dir / f'{step}_prompt.txt').read_text()

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

    return prompt_text, getattr(module, class_name)
