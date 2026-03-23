# ─── Stage 1: Base ────────────────────────────────────────────────────────────
FROM oven/bun:1.2.8-alpine AS base
WORKDIR /app

# ─── Stage 2: Install dependencies ────────────────────────────────────────────
FROM base AS installer

# Copy root workspace config
COPY package.json bun.lock ./
COPY turbo.json* ./

# Copy package manifests for all workspace members control pod needs
COPY apps/control/package.json          ./apps/control/package.json
COPY packages/shared-redis/package.json ./packages/shared-redis/package.json
COPY packages/types/package.json        ./packages/types/package.json
COPY packages/r2/package.json           ./packages/r2/package.json

# Install all workspace deps from root (respects workspaces)
RUN bun install --ignore-scripts

# ─── Stage 3: Copy source ─────────────────────────────────────────────────────
FROM installer AS builder

# Copy source for shared packages
COPY packages/shared-redis/ ./packages/shared-redis/
COPY packages/types/        ./packages/types/
COPY packages/r2/           ./packages/r2/

# Copy control pod source
COPY apps/control/          ./apps/control/

# ─── Stage 4: Production image ────────────────────────────────────────────────
FROM oven/bun:1.2.8-alpine AS runner
WORKDIR /app

# Copy everything needed to run (node_modules + source)
COPY --from=builder /app/node_modules          ./node_modules
COPY --from=builder /app/packages/shared-redis ./packages/shared-redis
COPY --from=builder /app/packages/types        ./packages/types
COPY --from=builder /app/packages/r2           ./packages/r2
COPY --from=builder /app/apps/control          ./apps/control

# Shared volume mount point for project files (populated at runtime by orchestrator)
RUN mkdir -p /app/shared

ENV NODE_ENV=production

WORKDIR /app/apps/control

CMD ["bun", "run", "src/index.ts"]