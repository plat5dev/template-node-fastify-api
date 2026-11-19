# Node + Fastify API starter

A lean, idiomatic Plat5 reference API built with **Node 26** (native TypeScript type stripping, no build step), **Fastify 5**, **TypeBox 1**, SQLite (`node:sqlite`), Pino structured logs, and OpenTelemetry + Prometheus.

Plat5 handles authentication and authorization at its gateway. This service owns domain logic only: it trusts the project/user IDs in the path and the caller headers forwarded by the front door ([`docs/guides/write-a-service.md`](https://github.com/plat5dev/plat5/blob/master/docs/guides/write-a-service.md)).

## Stack

- **Runtime:** Node 26 LTS running `.ts` directly (`npm run check` runs `tsc --noEmit`)
- **HTTP & Validation:** Fastify 5 + `@fastify/type-provider-typebox` + TypeBox 1; OpenAPI at `/openapi.json` and Swagger UI at `/docs`
- **Storage:** SQLite via `node:sqlite` (WAL mode)
- **Telemetry:** Fastify's built-in Pino logger (JSON stdout), OpenTelemetry SDK (`AsyncLocalStorageContextManager`, W3C `traceparent`, OTLP HTTP export when configured), and Prometheus `/metrics` on `INTERNAL_PORT`
- **Tests:** `node:test` + Fastify `app.inject`

## Routes

### Public (`PORT=3000`)

| Gateway path | Upstream path | Permission | Notes |
|--------------|---------------|------------|-------|
| `GET …/tasks` | `GET /projects/:project_id/tasks` | `project:read` | Paginated (`limit` default 50 / max 100, `starting_after` lowercase ULID) |
| `POST …/tasks` | `POST /projects/:project_id/tasks` | `project:write` | Requires `X-Plat5-Member-Id`; checks `assignee_id` via identity access eval |
| `GET …/tasks/:task_id` | `GET /projects/:project_id/tasks/:task_id` | `project:read` | Scoped to `project_id` (`404` across projects) |
| `PATCH …/tasks/:task_id` | `PATCH /projects/:project_id/tasks/:task_id` | `project:write` | Partial update; `assignee_id: null` unassigns; no-op skips DB write |
| `DELETE …/tasks/:task_id` | `DELETE /projects/:project_id/tasks/:task_id` | `project:write` | `204` or `404` |
| `GET /user/profile` | `GET /users/:user_id/profile` | user route | Lazily creates an empty profile |
| `PUT /user/profile` | `PUT /users/:user_id/profile` | user route | Upserts `bio` (≤ 2000 code points) |

`…` is `/orgs/{organization}/projects/{project}`. Errors follow the Plat5 error envelope ([`docs/reference/errors.md`](https://github.com/plat5dev/plat5/blob/master/docs/reference/errors.md)), lists follow [`docs/reference/lists.md`](https://github.com/plat5dev/plat5/blob/master/docs/reference/lists.md), and writes emit `X-Plat5-Audit-Details` / `X-Plat5-Audit-Created` ([`docs/concepts/audit.md`](https://github.com/plat5dev/plat5/blob/master/docs/concepts/audit.md)).

### Internal (`INTERNAL_PORT=3001`)

- `GET /health/live` → `200 {"status":"healthy"}`
- `GET /health/ready` → SQLite `SELECT 1` (`200` or `503`)
- `GET /metrics` → Prometheus scrape (`http_requests_total`, `http_request_duration_seconds`, process metrics)

## Identity integrations

- **Assignee access check (`src/access.ts`):** When a task sets a non-null `assignee_id`, the API calls `POST {IDENTITY_INTERNAL_URL}/access/v1/evaluation` for `TASK_ASSIGNEE_PERMISSION` on `project`, forwarding `X-Request-ID` and `traceparent` from the active OTel context. Denied → `422`; unavailable or unset → fail-closed `503` ([`docs/reference/api/internal.md`](https://github.com/plat5dev/plat5/blob/master/docs/reference/api/internal.md)).
- **Lifecycle consumer (`src/lifecycle.ts`):** Polls `GET {IDENTITY_INTERNAL_URL}/internal/events?types=node.purged,user.deleted&limit=100` to delete purged projects' tasks and deleted users' profiles atomically with the SQLite cursor in `feed_cursors`, resetting on `409 CURSOR_AHEAD` ([`docs/concepts/lifecycle.md`](https://github.com/plat5dev/plat5/blob/master/docs/concepts/lifecycle.md)).

## Running

```bash
plat5 start
```

Or run the API locally outside Docker against the local Plat5 stack:

```bash
plat5 start -x app
npm install
TASK_ASSIGNEE_PERMISSION=project:read npm run dev
```

Commands:

```bash
TASK_ASSIGNEE_PERMISSION=project:read npm run dev   # node --watch (reads .env if present)
TASK_ASSIGNEE_PERMISSION=project:read npm start     # node src/main.ts
npm run check                                       # TypeScript type check
npm test                                            # node:test suite
```

## Environment

See `.env.example`.

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | Public API + `/docs` |
| `INTERNAL_PORT` | `3001` | `/health/live`, `/health/ready`, `/metrics` |
| `DATABASE_PATH` | `./data/app.db` | SQLite database file |
| `IDENTITY_INTERNAL_URL` | unset | Identity internal URL (lifecycle feed + assignee check) |
| `TASK_ASSIGNEE_PERMISSION` | **required** | Permission checked for task assignees (starter: `project:read`) |
| `APP_VERSION` | `dev` | Service version in OpenAPI and OTel resource |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | Enables OTLP traces & metrics push; standard `OTEL_*` vars are read by the OTel SDK ([`docs/reference/telemetry.md`](https://github.com/plat5dev/plat5/blob/master/docs/reference/telemetry.md)) |

## Layout

```text
src/
  main.ts         # Boot, startup rollback, graceful shutdown
  app.ts          # Fastify + Pino, error/404 handlers, Swagger, routes
  config.ts       # Environment config validation
  telemetry.ts    # OTel SDK, Prometheus metrics, observability plugin
  internal.ts     # Internal HTTP server (/health/*, /metrics)
  db.ts           # node:sqlite connection, schema, transactions
  errors.ts       # Plat5 error envelope + AJV validation mapper
  schemas.ts      # TypeBox schemas & list pagination helpers
  audit.ts        # X-Plat5-Audit-Details / X-Plat5-Audit-Created
  access.ts       # Identity access evaluation client
  lifecycle.ts    # Identity lifecycle event consumer
  tasks.ts        # Project task routes & SQLite store
  profiles.ts     # User profile routes & SQLite store
plat5.yml         # Deployment config (kinds, roles, rate limits, services)
services/         # Service route definitions (api, identity, audit)
plat5.local.yml   # Local dev stack configuration
```

## Docker

```bash
docker compose up --build
docker build --target prod --build-arg VERSION=v1.2.3 -t api .
```
