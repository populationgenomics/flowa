FROM ghcr.io/astral-sh/uv:python3.13-trixie-slim

# Support for custom build steps
COPY README* *build.d /build.d/
RUN bash -c 'for i in $(ls /build.d/*.sh 2>/dev/null | sort) ; do source $i ; done'

WORKDIR /app

# Copy all project files
COPY pyproject.toml uv.lock LICENSE README.md ./
COPY src/ ./src/
COPY prompts/ ./prompts/

# Export dependencies and install system-wide to use system certs
RUN uv export --frozen --no-hashes --no-dev -o requirements.txt && \
    uv pip install --system -r requirements.txt && \
    uv pip install --system -e .

ENTRYPOINT ["flowa"]
