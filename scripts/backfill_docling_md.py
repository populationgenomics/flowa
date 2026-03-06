"""One-off backfill: generate docling.md and docling_bbox.json for existing papers.

Usage:
    FLOWA_STORAGE_BASE=s3://curio-flowa-test uv run python scripts/backfill_docling_md.py
"""

import json
import logging

import fsspec

from flowa.docling import serialize_with_bbox_ids
from flowa.storage import _get_base

logging.basicConfig(level=logging.INFO, format='%(levelname)s %(message)s')
log = logging.getLogger(__name__)


def main() -> None:
    base = _get_base()
    papers_prefix = f'{base}/papers/'

    fs, papers_path = fsspec.core.url_to_fs(papers_prefix)

    # glob doesn't work with percent-encoded DOI paths, so list + filter
    paper_dirs = fs.ls(papers_path)
    docling_files = [(d, f'{d}/docling.json') for d in paper_dirs if fs.exists(f'{d}/docling.json')]

    log.info('Found %d docling.json files', len(docling_files))

    for paper_dir, docling_path in docling_files:
        md_path = f'{paper_dir}/docling.md'

        if fs.exists(md_path):
            log.info('Skipping %s (already backfilled)', paper_dir)
            continue

        log.info('Processing %s', paper_dir)
        with fs.open(docling_path, 'r') as f:
            docling_json = json.load(f)

        markdown, bbox_mapping = serialize_with_bbox_ids(docling_json)

        with fs.open(md_path, 'w') as f:
            f.write(markdown)
        with fs.open(f'{paper_dir}/docling_bbox.json', 'w') as f:
            json.dump({str(k): v for k, v in bbox_mapping.items()}, f, indent=2)

    log.info('Done')


if __name__ == '__main__':
    main()
