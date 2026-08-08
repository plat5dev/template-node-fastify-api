# Node + Fastify API template

Reference Plat5 business service: **Node.js** + **pnpm**, **Fastify**, **Zod**, SQLite via **better-sqlite3**.

Gateway authenticates. This service trusts identity headers and owns business logic only.

## Stack

| Piece | Choice |
|-------|--------|
| Runtime / installs | Node 22+ / pnpm |
| HTTP | Fastify 5 |
| Schema | Zod (+ `@fastify/swagger` OpenAPI) |
| DB | SQLite via `better-sqlite3` |
| Dev | `tsx watch` |
| Prod | `tsc` → `node dist/main.js` |
| IDs | ULID |

## Demo domain

| Resource | Scope | Identity headers |
|----------|-------|------------------|
| Profiles | `user` | `X-User-Id` |
| Projects | `organization` | `X-Organization-Id`, `X-Membership-Id` |
| Tasks | `organization` (nested under project) | same |

Missing expected identity headers → **500 `INTERNAL_ERROR`** (platform bug), never 401.

## Quick start (host app + Plat5 CLI)

```bash
mkdir my-app && cd my-app
plat5 init --template node-fastify-api --auth -y

pnpm install
plat5 start          # gateway :5001, registry :5002, applies routes.yml
pnpm run dev         # API :3000, health :3001
```

`plat5.template.yml` drives init (upstreams, routes, next steps). The CLI fetches this repo, copies the tree, and writes `plat5.yml`.

Community / fork:
```bash
plat5 init --template plat5dev/template-node-fastify-api --auth -y
```

## Commands

```bash
pnpm run dev     # tsx watch src/main.ts
pnpm run build   # tsc → dist/
pnpm run start   # node dist/main.js
pnpm run check   # tsc --noEmit
```

## Ports

| Port | Env | Purpose |
|------|-----|---------|
| 3000 | `PORT` | Public API (+ `/docs` OpenAPI) |
| 3001 | `INTERNAL_PORT` | `/health/live`, `/health/ready`, `/metrics` (health/metrics not traced) |

## Environment

See `.env.example`. Load with your process manager or `export $(grep -v '^#' .env | xargs)`.

| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` | `3000` | Public |
| `INTERNAL_PORT` | `3001` | Health + `/metrics` |
| `DATABASE_PATH` | `./data/app.db` | SQLite file |
| `OTEL_SERVICE_NAME` | `api` | Resource `service.name` (standard OTel) |
| `OTEL_RESOURCE_ATTRIBUTES` | unset | Standard bag: `service.namespace=…,service.version=…,…` |
| `OTEL_SERVICE_NAMESPACE` | `api` | Convenience → `service.namespace` |
| `OTEL_SERVICE_VERSION` | `0.0.0` | Convenience → `service.version` |
| `OTEL_SERVICE_INSTANCE_ID` | hostname | Convenience → `service.instance.id` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | OTLP destination. Unset → no OTLP |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | unset | Optional full traces URL |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | unset | Optional full metrics URL |
| `OTEL_TRACES_EXPORTER` | `otlp` when endpoint set | Include `otlp` to push traces |
| `OTEL_METRICS_EXPORTER` | `otlp` when endpoint set | Set `prometheus` to push-off; `/metrics` always on |
| `OTEL_METRIC_EXPORT_INTERVAL` | `30000` | ms (OTLP metrics) |
| `OTEL_SDK_DISABLED` | `false` | Force OTLP off; stdout + `/metrics` remain |
| `DEPLOYMENT_ENV` | `development` | Resource `deployment.environment` |

## Telemetry

Telemetry aligns with Plat5 service conventions (JSON access logs, `/metrics`, optional OTLP).

| Signal | Path |
|--------|------|
| Logs | JSON access line per request on stdout (not OTLP logs) |
| Metrics scrape | Prometheus `/metrics` on `INTERNAL_PORT` |
| Traces | OTLP HTTP when endpoint set (default) |
| Metrics OTLP | On when endpoint set (default); set `OTEL_METRICS_EXPORTER=prometheus` to opt out |

```bash
# traces push + scrape metrics (no double count)
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 pnpm run dev

# full OTLP push — do not also scrape /metrics into the same backend
# OTEL_METRICS_EXPORTER=prometheus  # opt out of metrics push

# container → host-published collector
# OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4318
```

`plat5.yml` `otel.endpoint` only injects into Plat5/Auth compose — set env on this app yourself.

Health on `INTERNAL_PORT` does not emit request spans.

## Docker

```bash
docker compose up --build
```

- `local` target: hot reload, source mount
- `prod` target: non-root, `tsc` build + pruned deps

## Layout

```
src/
  main.ts                 # dual HTTP servers + SQL + optional OTLP
  config.ts               # env → AppConfig
  db.ts                   # better-sqlite3 + migrate
  telemetry.ts            # OTel SDK (OTLP traces/metrics)
  metrics.ts              # prom-client scrape + HTTP/DB metrics
  errors.ts               # Plat5 error envelope
  middleware/             # identity headers, access log, spans
  schemas/                # Zod models
  profiles|projects|tasks/  # routes + store
routes.yml                # gateway scopes (route_prefix per scope)
```

## Plat5 contracts (do / don't)

**Do**

- Trust `X-User-Id` on user routes; `X-Organization-Id` + `X-Membership-Id` on org routes
- Return Plat5 error envelope (`error.type/code/message/request_id/details`)
- Log one JSON access line per request (`request_id`, `duration_ms`, identity when present)
- OTLP traces + metrics when endpoint set; always stdout + `/metrics`
- Publish routes via `routes.yml` → route-registry (`route_prefix`: `/api` user, `/api/organizations/{organization_id}` org)

**Don't**

- Parse `Authorization` or validate JWTs
- Implement CORS (gateway owns it)
- Set `X-Request-ID` on responses
- Return 401 for missing identity headers

## Contract e2e

Contract e2e tests live in the Plat5 monorepo (`plat5/e2e`, `test:templates`) and hit profiles / projects / tasks **through the gateway**.
