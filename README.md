# Flowa

Variant literature assessment pipeline with AI extraction.

## Installation

```bash
uv sync --extra dev

```

On macOS: add `--extra macos` for faster Docling conversion.

## Configuration

Copy `.env.example` to `.env` and configure your API keys.

All variant information and processing state is stored in `data/db.sqlite`.

## Workflow

```bash
VARIANT=GAA_variant

# 1. Query literature
uv run flowa query --gene GAA --hgvs "c.2238G>C" --id $VARIANT --source litvar

# 2. Download PDFs
# Note: Reports which papers are not open-access and must be downloaded manually
uv run flowa download --id $VARIANT

# 3. Convert PDFs to Docling JSON (manual step)
cd data/papers && uv run docling --to json --pipeline vlm --vlm-model granite_docling *.pdf && cd ../..

# 4. Extract and aggregate evidence
uv run flowa process --id $VARIANT

# 5. Annotate PDFs
uv run flowa annotate --id $VARIANT

# 6. Generate report
uv run flowa report --id $VARIANT --output reports/$VARIANT/index.html
```
