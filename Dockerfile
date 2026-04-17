FROM ghcr.io/astral-sh/uv:python3.13-trixie-slim

# Required for git-sourced deps in pyproject.toml/uv.lock (currently the
# pydantic-ai-slim fork pin). Drop once all deps come from a registry.
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

# Support for custom build steps
COPY README* *build.d /build.d/
RUN bash -c 'for i in $(ls /build.d/*.sh 2>/dev/null | sort) ; do source $i ; done'

ARG LLM_EXTRA

WORKDIR /app

# Copy all project files
COPY pyproject.toml uv.lock LICENSE README.md ./
COPY src/ ./src/
COPY prompts/ ./prompts/

# Export dependencies and install system-wide to use system certs
RUN uv export --frozen --no-hashes --no-dev --extra "${LLM_EXTRA}" -o requirements.txt && \
    uv pip install --system -r requirements.txt && \
    uv pip install --system -e ".[$LLM_EXTRA]"

ENTRYPOINT ["flowa"]
