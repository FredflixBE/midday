# Base image with Bun
FROM oven/bun:1.3.10 AS base

# Install turbo CLI globally using Bun
FROM base AS turbo-cli
# Pinned to the same turbo the repo builds with. Unpinned, this line
# installed whatever the dist-tag pointed at on the day the image was
# built — the very defect the rest of this change removes — and the two
# versions do not prune alike: see scripts/repair-pruned-lockfile.ts.
RUN bun add -g turbo@2.9.3

# Builder stage - prune dashboard workspace
FROM turbo-cli AS builder
WORKDIR /app
# Copy all files
COPY . .
# Optional git SHA stamp. CI writes .git-commit-sha before the build; a plain
# checkout (Dokploy) has none, so fall back to the GIT_COMMIT_SHA build arg or
# an empty file. The entrypoint exports it as GIT_COMMIT_SHA at runtime.
ARG GIT_COMMIT_SHA=""
RUN [ -f .git-commit-sha ] || printf '%s' "$GIT_COMMIT_SHA" > .git-commit-sha
# Prune dashboard workspace
RUN turbo prune @midday/dashboard --docker
# `turbo prune` emits a bun.lock that bun cannot read back: any dependency
# resolved from a tarball URL is rewritten into the registry shape, and bun
# answers by ignoring the lockfile entirely and re-resolving from npm. Put
# those entries back so the install below has a lockfile to be frozen against.
RUN bun scripts/repair-pruned-lockfile.ts out/json/bun.lock

# Installer stage
FROM base AS installer
WORKDIR /app

# Copy package.json files from pruned workspace
COPY --from=builder /app/out/json/ .
COPY bunfig.toml .

# Install dependencies
# Frozen, so the image installs the versions CI validated rather than
# whatever the registry serves at build time.
RUN bun install --frozen-lockfile

# Copy full source from pruned workspace
COPY --from=builder /app/out/full/ .

# Build-time NEXT_PUBLIC_ env vars (passed as build args; see apps/dashboard/.env.example)
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_URL
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_INBOX_FORWARDING_DOMAIN
ARG NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_GOOGLE_API_KEY
ARG NEXT_PUBLIC_DESKTOP_SCHEME

# Server Action encryption key — must be identical across all replicas
# to prevent "Failed to find Server Action" errors. Base64-encoded, 32 bytes.
ARG NEXT_SERVER_ACTIONS_ENCRYPTION_KEY
ENV NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=$NEXT_SERVER_ACTIONS_ENCRYPTION_KEY

# Git SHA stamp written by the builder stage (see above); may be empty.
COPY --from=builder /app/.git-commit-sha /tmp/git-sha.txt

ENV CI=true
ENV NODE_ENV=production

# Build with GIT_COMMIT_SHA exported so next.config.ts can read it via
# process.env.
RUN GIT_COMMIT_SHA=$(cat /tmp/git-sha.txt 2>/dev/null || echo ""); \
    export GIT_COMMIT_SHA; \
    bunx turbo run build --filter=@midday/dashboard --only

# Runner stage - clean bun image, no turbo
FROM oven/bun:1.3.10 AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --no-log-init -g nodejs nextjs

# Copy standalone output
COPY --from=installer --chown=nextjs:nodejs /app/apps/dashboard/.next/standalone ./
COPY --from=installer --chown=nextjs:nodejs /app/apps/dashboard/.next/static ./apps/dashboard/.next/static
COPY --from=installer --chown=nextjs:nodejs /app/apps/dashboard/public ./apps/dashboard/public

# Carry the git SHA into the runtime container and use the shared entrypoint to
# set GIT_COMMIT_SHA when the platform doesn't provide it.
COPY --from=installer /tmp/git-sha.txt /tmp/git-sha.txt
COPY --from=builder /app/scripts/docker-entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

USER nextjs

EXPOSE 3000

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["bun", "apps/dashboard/server.js"]
