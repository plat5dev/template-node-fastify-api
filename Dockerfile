# ======================================================================
# Local — hot reload
# ======================================================================
FROM node:22-bookworm AS local

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@10.12.1 --activate

# pnpm-workspace.yaml carries onlyBuiltDependencies so better-sqlite3 scripts run
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
RUN pnpm install

COPY . .

ENV PORT=3000
ENV INTERNAL_PORT=3001
ENV DATABASE_PATH=/data/app.db

EXPOSE 3000

CMD ["pnpm", "run", "dev"]

# ======================================================================
# Builder
# ======================================================================
FROM node:22-bookworm AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@10.12.1 --activate

COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build && pnpm prune --prod

# ======================================================================
# Prod — minimal
# ======================================================================
FROM node:22-bookworm-slim AS prod

WORKDIR /app

RUN groupadd -r app && useradd -r -g app app \
  && mkdir -p /data && chown app:app /data

COPY --from=builder --chown=app:app /app/package.json ./
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/dist ./dist

USER app

ENV NODE_ENV=production
ENV PORT=3000
ENV INTERNAL_PORT=3001
ENV DATABASE_PATH=/data/app.db

EXPOSE 3000

CMD ["node", "dist/main.js"]
