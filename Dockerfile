# Node runs the TypeScript in src/ as it is, its type stripping erasing the types: no build step.

# ======================================================================
# Local — hot reload
# ======================================================================
FROM node:26-trixie-slim AS local

WORKDIR /app

# sqlite3, to look in the database or reset the lifecycle cursor (README).
RUN apt-get update && apt-get install -y --no-install-recommends sqlite3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ENV PORT=3000
ENV INTERNAL_PORT=3001
ENV DATABASE_PATH=/data/app.db

EXPOSE 3000

CMD ["node", "--watch", "src/main.ts"]

# ======================================================================
# Prod — minimal
# ======================================================================
FROM node:26-trixie-slim AS prod

WORKDIR /app

RUN mkdir -p /data && chown node:node /data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
# The release this image reports as service.version; dev without one.
ARG VERSION=dev
RUN node -e 'require("node:fs").writeFileSync("src/version.ts", `export const VERSION = ${JSON.stringify(process.env.VERSION)}\n`)'

USER node

ENV NODE_ENV=production
ENV PORT=3000
ENV INTERNAL_PORT=3001
ENV DATABASE_PATH=/data/app.db

EXPOSE 3000

CMD ["node", "src/main.ts"]
