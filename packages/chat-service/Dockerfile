# Reference Dockerfile for @flowajs/chat-service.
#
# This builds the default env-driven entry. Production deployments that
# need custom cred-minting (OIDC->STS, etc.) typically write a thin
# wrapper that uses createApp() programmatically and replace the CMD with
# their wrapper's entry point. See README.md "Production deployment".
#
# Build context is expected to be the monorepo root (so the Dockerfile
# can reach pnpm-workspace.yaml + tsconfig.base.json + the package
# directory). Build with:
#
#   docker build -f packages/chat-service/Dockerfile -t chat-service .

FROM node:22-bookworm-slim AS build

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /workspace

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/chat-service/package.json packages/chat-service/

RUN pnpm install --frozen-lockfile --filter @flowajs/chat-service

COPY packages/chat-service/ packages/chat-service/

RUN pnpm --filter @flowajs/chat-service build

# Slim runtime stage: copy only built dist + production node_modules.
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

COPY --from=build /workspace/packages/chat-service/dist ./dist
COPY --from=build /workspace/packages/chat-service/node_modules ./node_modules
COPY --from=build /workspace/packages/chat-service/package.json ./
COPY packages/chat-service/prompts ./prompts

ENV NODE_ENV=production
EXPOSE 8000

CMD ["node", "--import", "./dist/instrumentation.js", "dist/index.js"]
