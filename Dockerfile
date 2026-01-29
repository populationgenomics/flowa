FROM ghcr.io/astral-sh/uv:python3.13-trixie-slim

# Support for custom build steps
COPY README* *build.d /build.d/
RUN bash -c 'for i in $(ls /build.d/*.sh 2>/dev/null | sort) ; do source $i ; done'

# Install system dependencies for OpenCV (required by docling's rapidocr)
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy all project files
COPY pyproject.toml uv.lock LICENSE README.md ./
COPY src/ ./src/
COPY prompts/ ./prompts/

# Export dependencies and install system-wide to use system certs
RUN uv export --frozen --no-hashes --no-dev -o requirements.txt && \
    uv pip install --system -r requirements.txt && \
    uv pip install --system -e .

# Support for custom build steps (post deps-install)
RUN bash -c 'for i in $(ls /build.d/*.sh 2>/dev/null | sort) ; do source $i ; done'

# Pre-download docling models to avoid runtime HuggingFace access
RUN docling-tools models download layout tableformer

# Point docling to its cache directory (avoids HuggingFace Hub lookups)
ENV DOCLING_ARTIFACTS_PATH=/root/.cache/docling/models

# No entrypoint - commands are executed directly
# Use "bash -c '...'" in DAG for chained commands
ENTRYPOINT []
