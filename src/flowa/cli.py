"""Main CLI entry point for Flowa."""

import logging
import os
import sys

import logfire
import typer
from pydantic_ai import Agent
from pydantic_ai.models.instrumented import InstrumentationSettings

from flowa import __version__, aggregate, convert, download, extract, query, run

app = typer.Typer(
    name='flowa',
    help='Variant literature assessment pipeline with AI extraction',
    add_completion=False,
)

# Configure root logger to write to stderr (stdout reserved for structured output)
# Done after imports so force=True overrides any library-configured logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(name)s: %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S',
    stream=sys.stderr,
    force=True,  # Override any existing configuration
)

# Set up OpenTelemetry via logfire. send_to_logfire=False means we only export
# via OTLP (to OTEL_EXPORTER_OTLP_ENDPOINT). Gracefully degrades to no-op when
# the env var is unset (local dev, tests).
logfire.configure(
    send_to_logfire=False,
    service_name='flowa-worker',
)
# Patches Agent class globally — captures all agent runs (including groundmark's
# PDF conversion agents) with zero changes in those modules.
Agent.instrument_all(
    InstrumentationSettings(
        include_content=False,
        version=3,
    )
)


@app.callback()
def main(
    log_level: str = typer.Option(
        os.environ.get('FLOWA_LOG_LEVEL', 'INFO'),
        '--log-level',
        '-l',
        help='Logging level (DEBUG, INFO, WARNING, ERROR)',
    ),
) -> None:
    """Flowa - Variant literature assessment pipeline."""
    level = getattr(logging, log_level.upper(), logging.INFO)
    logging.getLogger().setLevel(level)
    # Suppress noisy third-party loggers even at DEBUG
    for name in ('pdfminer', 'pdfplumber', 'pypdfium2'):
        logging.getLogger(name).setLevel(logging.WARNING)


# Register commands
app.command(name='run')(run.run)
app.command(name='query')(query.query_dois)
app.command(name='download')(download.download_paper)
app.command(name='convert')(convert.convert_paper)
app.command(name='extract')(extract.extract_paper)
app.command(name='aggregate')(aggregate.aggregate_evidence)


@app.command()
def version() -> None:
    """Show version information."""
    print(f'Flowa version {__version__}')


if __name__ == '__main__':
    app()
