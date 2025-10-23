"""Main CLI entry point for Flowa."""

import logging

import typer

from flowa import __version__
from flowa.commands import annotate, download, process, query, report

app = typer.Typer(
    name='flowa',
    help='Variant literature assessment pipeline with AI extraction',
    add_completion=False,
)


def setup_logging(log_level: str) -> None:
    """Configure logging for the application.

    Args:
        log_level: Logging level (DEBUG, INFO, WARNING, ERROR)
    """
    level_map = {
        'DEBUG': logging.DEBUG,
        'INFO': logging.INFO,
        'WARNING': logging.WARNING,
        'ERROR': logging.ERROR,
    }

    logging.basicConfig(
        level=level_map.get(log_level.upper(), logging.INFO),
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    )


@app.callback()
def main(
    log_level: str = typer.Option(
        'INFO',
        '--log-level',
        '-l',
        help='Logging level (DEBUG, INFO, WARNING, ERROR)',
    ),
) -> None:
    """Flowa - Variant literature assessment pipeline."""
    setup_logging(log_level)


# Register commands
app.command(name='query')(query.query_pmids)
app.command(name='download')(download.download_pdfs)
app.command(name='process')(process.process_variant)
app.command(name='annotate')(annotate.annotate_pdfs)
app.command(name='report')(report.generate_report)


@app.command()
def version() -> None:
    """Show version information."""
    typer.echo(f'Flowa version {__version__}')


if __name__ == '__main__':
    app()
