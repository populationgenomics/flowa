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


def get_prompt_set() -> str:
    """Return current prompt set name from FLOWA_PROMPT_SET env var."""
    return os.environ.get('FLOWA_PROMPT_SET', 'generic')


def get_prompts_dir() -> Path:
    """Return path to current prompt set directory.

    Raises:
        ValueError: If the prompt set directory does not exist.
    """
    prompt_set = get_prompt_set()
    prompts_dir = Path('prompts') / prompt_set

    if not prompts_dir.exists():
        available = [p.name for p in Path('prompts').iterdir() if p.is_dir()]
        raise ValueError(f"Prompt set '{prompt_set}' not found at {prompts_dir}. Available prompt sets: {available}")

    log.info('Using prompt set: %s', prompt_set)
    return prompts_dir


def load_prompt(name: str) -> str:
    """Load a prompt template (.txt) from current prompt set.

    Args:
        name: Base name of the prompt file (without .txt extension)

    Returns:
        The prompt template content as a string.
    """
    prompt_path = get_prompts_dir() / f'{name}.txt'
    return prompt_path.read_text()


def load_model(name: str, class_name: str) -> 'type[BaseModel]':
    """Load a Pydantic model class from a schema module in the current prompt set.

    Args:
        name: Base name of the schema file (without .py extension)
        class_name: Name of the Pydantic model class to load

    Returns:
        The Pydantic model class.
    """
    module_path = get_prompts_dir() / f'{name}.py'

    spec = importlib.util.spec_from_file_location(f'{get_prompt_set()}_{name}', module_path)
    if spec is None or spec.loader is None:
        raise ImportError(f'Could not load module from {module_path}')

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    if not hasattr(module, class_name):
        raise AttributeError(f"Module {module_path} does not define '{class_name}'")

    return getattr(module, class_name)
