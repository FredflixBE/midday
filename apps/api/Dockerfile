# Base image with Bun
FROM oven/bun:1.3.10 AS base

# Install turbo CLI globally
FROM base AS turbo-cli
RUN bun add -g turbo

# Builder stage - prune API workspace
FROM turbo-cli AS builder
WORKDIR /app
COPY . .
# Optional git SHA stamp. CI writes .git-commit-sha before the build; a plain
# checkout (Dokploy) has none, so fall back to the GIT_COMMIT_SHA build arg or
# an empty file. The entrypoint exports it as GIT_COMMIT_SHA at runtime.
ARG GIT_COMMIT_SHA=""
RUN [ -f .git-commit-sha ] || printf '%s' "$GIT_COMMIT_SHA" > .git-commit-sha
RUN turbo prune @midday/api --docker
# `turbo prune` emits a bun.lock that bun cannot read back: any dependency
# resolved from a tarball URL is rewritten into the registry shape, and bun
# answers by ignoring the lockfile entirely and re-resolving from npm. Put
# those entries back so the install below has a lockfile to be frozen against.
RUN bun scripts/repair-pruned-lockfile.ts out/json/bun.lock

# Installer stage - install deps and build
FROM base AS installer
WORKDIR /app

# Install dependencies
COPY --from=builder /app/out/json/ .
COPY bunfig.toml .
# Frozen, so the image installs the versions CI validated rather than
# whatever the registry serves at build time.
RUN bun install --frozen-lockfile

# Copy full source
COPY --from=builder /app/out/full/ .

# Build the mcp-apps package (produces self-contained HTML files)
RUN cd packages/mcp-apps && bun run build

# Runner stage - clean image
FROM oven/bun:1.3.10 AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# Copy only what's needed at runtime
COPY --from=installer /app/node_modules ./node_modules
COPY --from=installer /app/apps/api ./apps/api
COPY --from=installer /app/packages ./packages
COPY --from=installer /app/package.json ./package.json

# Carry the git SHA into the runtime container (optional; see the builder stage)
COPY --from=builder /app/.git-commit-sha /tmp/git-sha.txt
COPY --from=builder /app/scripts/docker-entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

WORKDIR /app/apps/api

EXPOSE 8080

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["bun", "src/index.ts"]
