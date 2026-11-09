# Node + Fastify API starter

A Plat5 API starter: **Node.js** running TypeScript as it is, **Fastify** with **TypeBox** schemas, SQLite via `node:sqlite`, Prometheus + OpenTelemetry. It serves tasks inside a project, and the person's own profile. The repo is a Plat5 project you can run as is: `plat5 start` in this directory runs Plat5, applies `plat5.yml`, and runs the API beside it.

Plat5 decides who may call what, at its gateway. This service owns business logic only: it reads the node ids and the caller's member id the front door gives it, and checks nothing about the caller ([plat5 `docs/guides/write-a-service.md`](https://github.com/plat5dev/plat5/blob/master/docs/guides/write-a-service.md)).

## Stack

| Piece | Choice |
|-------|--------|
| Runtime / installs | Node 26 (LTS) / npm. Node runs the `.ts` files as they are, stripping their types: no build step |
| HTTP | Fastify 5: content-type parsers, hooks, `setErrorHandler`, `setNotFoundHandler` |
| Schema | TypeBox via `@fastify/type-provider-typebox`. Fastify's AJV validates each request against its route's schemas (no type coercion, a body's unknown keys refused, every wrong field reported); `src/validation.ts` turns what fails into Plat5's 422. The same schemas are the OpenAPI document (`@fastify/swagger`: Swagger UI at `/docs`, the document at `/openapi.json`) |
| DB | SQLite via Node's own `node:sqlite` |
| Telemetry | OpenTelemetry: one meter for every series, read by the Prometheus exporter for `/metrics` and pushed over OTLP when that's on; traces over OTLP |
| Dev | `node --watch` |
| Tests | `node --test`, Fastify's `inject`, identity faked by a local HTTP server |
| IDs | ULID, lowercase |

| Dependency | For |
|------------|-----|
| `fastify`, `@fastify/type-provider-typebox`, `typebox` | HTTP, schemas, validation |
| `@fastify/swagger`, `@fastify/swagger-ui` | The OpenAPI document, and `/docs` |
| `ulid` | Task ids, monotonic |
| `@opentelemetry/api`, `core`, `resources`, `sdk-trace`, `sdk-metrics` | Spans, series, the resource, W3C Trace Context |
| `@opentelemetry/exporter-prometheus`, `exporter-metrics-otlp-http`, `exporter-trace-otlp-http` | `/metrics`, and the OTLP pushes |
| `typescript`, `@types/node` (dev) | `npm run check` |

## What it serves

Organizations and projects are Plat5 nodes, kinds in `plat5.yml` (organization > project): created, listed, renamed, deleted and restored through identity's routes (`/orgs/{organization}/projects`…), with their name as the node's `display_name`. The API keeps no projects of its own. It serves what's inside a project:

| Public (gateway) | The API's own path | Permission |
|--|--|--|
| `GET …/tasks` | `GET /projects/{project_id}/tasks` | `project:read` |
| `POST …/tasks` | `POST /projects/{project_id}/tasks` | `project:write` |
| `GET …/tasks/{task_id}` | `GET /projects/{project_id}/tasks/{task_id}` | `project:read` |
| `PATCH`, `DELETE …/tasks/{task_id}` | the same, on `/projects/{project_id}/tasks/{task_id}` | `project:write` |
| `GET`, `PUT /user/profile` | `/users/{user_id}/profile` | user route |

`…` is `/orgs/{organization}/projects/{project}`. `{organization}` and `{project}` take a slug or an id; the gateway resolves them and sends the project's id. They answer only for what the caller may reach: a project they can't use, or one that doesn't exist, is the gateway's **403**.

| Data | Keyed by | Fields |
|------|----------|--------|
| Task | The project's node id | `id`, `project_id`, `title`, `status` (`todo`, `in_progress`, `done`), `assignee_id` (a member id, or `null`), `created_by`, `created_at`, `updated_at` |
| Profile | The user id | `user_id`, `bio`, `created_at`, `updated_at` |

A task is authored: `created_by` is the member id of whoever created it, and stays theirs if they leave the tree ([where a field goes](https://github.com/plat5dev/plat5/blob/master/docs/concepts/model.md#where-a-field-goes)). Its `assignee_id` is a member of the same tree who can see the project, checked with identity when it's set ([Checking an assignee](#checking-an-assignee)). A profile is the person's, the same in every tree, so it sits on a user route. The person's name is identity's (`GET /user`), not the profile's.

Ids are lowercase ULIDs with no prefix, like every Plat5 id.

A write's body is JSON: not sent as `application/json` (any parameters, the type in any case; `application/merge-patch+json` isn't it), empty, or not JSON is a **400** `INVALID_REQUEST`, as is a create without `X-Plat5-Member-Id`, checked before the body is read ([plat5 `docs/reference/errors.md`](https://github.com/plat5dev/plat5/blob/master/docs/reference/errors.md#which-status)). Its values are checked by its schema (`src/schemas.ts`), never coerced: each wrong one is in a **422**'s `details.fields`, once, at its path (`title`, `address.street`, `tags[0].name`; the body itself, an array say, is `body`), in the body's order, with its sentence, and the first one's sentence is the `message`. Keys match exactly: `{"Title": …}` isn't `title`, and a body with an unknown key is refused for those alone, before its values are checked, each `{"path": "Title", "message": "Title isn't a field."}`. A `DELETE` reads no body.

| Field | Rule | Sentence |
|-------|------|----------|
| `title` | Trimmed of white space, then 1 to 255 characters (code points). Required on a create; on a `PATCH`, absent or `null` leaves it | `Title is required.`, `Title is too long.`; another type, or `null` on a create: `That doesn't look right.` |
| `status` | `todo`, `in_progress` or `done`. A create without one is `todo`; on a `PATCH`, absent or `null` leaves it | `Status must be todo, in progress, or done.`, for any wrong value or type |
| `assignee_id` | A lowercase ULID, or `null` for none ([Checking an assignee](#checking-an-assignee)) | `That doesn't look right.` |
| `bio` | Required, at most 2000 characters, kept as sent (not trimmed; `""` is a bio) | `Bio is required.`, `Bio is too long.`; another type or `null`: `That doesn't look right.` |

Times are RFC 3339 in UTC, to the millisecond (`2026-10-28T00:00:00.100Z`). A profile is made, empty, on the person's first call.

## The config

| File | What |
|------|------|
| `plat5.yml` | The deployment's config: settings, the `organization` and `project` kinds (projects don't bind their creator), the example roles (`admin`, `member`, `developer`, `viewer`), `creator_role`, the `standard` rate limit that `defaults.rate_limit` names, and the service files ([plat5 `docs/concepts/config.md`](https://github.com/plat5dev/plat5/blob/master/docs/concepts/config.md#the-config)) |
| `services/api.yml` | This API's service file: its url (`http://api:3000`) and its routes, in the `project` and `user` scopes ([services](https://github.com/plat5dev/plat5/blob/master/docs/reference/config/services.md)) |
| `services/identity.yml`, `services/audit.yml` | Identity's and audit's service files: their routes at every kind, written by `plat5 routes generate`: service accounts and invites at organizations and projects alike. Run it again after changing the kinds ([generated routes](https://github.com/plat5dev/plat5/blob/master/docs/reference/config/generated-routes.md)) |
| `plat5.dev.yml` | How `plat5 start` runs the project on your machine: image versions, modules, and `app.compose` |
| `docker-compose.yml` | The API's container, `api`, on port 3000 |
| `routes.operator.yml` | What the operator plane may call on this API: the read routes, by project id (operator `docs/reference/routes.md`) |
| `plat5.template.yml` | The starter's manifest for `plat5 init`: its config, operator routes, compose file and next steps |

In a project made with `plat5 init --template node-fastify-api`, this API sits in `api/`, its service file is the project's `services/api.yml`, its operator routes are in the project's `operator.routes.yml`, and the project has its own `plat5.yml` and `plat5.dev.yml` at its root.

## What it trusts

Only front doors may reach the API: Plat5's gateway, an operator plane, anything else on the private network. Anyone who can call it directly can name any project in the path. Locally, `plat5 start` puts the container on the Plat5 network, where the gateway calls it as `http://api:3000`, and the host port is bound to `127.0.0.1` for your own curls. In production, don't publish the port at all.

| It reads | From | On |
|----------|------|----|
| The project's id | The path, `/projects/{project_id}/…`, written by `upstream_prefix: /projects/{project.id}` | Task routes; the assignee check |
| The caller's member id | `X-Plat5-Member-Id` | Task creates (required: **400** `INVALID_REQUEST` without it); request logs |
| The caller's user id | The path, `/users/{user_id}/profile`, written by `upstream: /users/{user.id}/profile` | Profile routes |
| `X-Request-ID` | The front door | Every request: logged, and in error bodies. Never set on a response |
| `traceparent` | The front door | Every request: the server span's parent |

The gateway also sends `X-Plat5-Project-Id`, `X-Plat5-Organization-Id` and `X-Plat5-User-Id`; the API reads the project's and the user's ids from the path, logs the project's and the user's from their headers, and has no use for the organization's. A body's size is the gateway's to limit (`max_body_bytes`). It never sees `Authorization`, a slug, a principal id, or the caller's permissions or role ([plat5 `docs/reference/headers.md`](https://github.com/plat5dev/plat5/blob/master/docs/reference/headers.md)).

Every lookup is scoped by the project id in the path, and nothing checks that the project exists or that the caller may act: the front door decided. A task id under another project is **404**.

## Checking an assignee

The caller may assign: the gateway let them write. The assignee isn't the caller, so the gateway decided nothing about them, and the API asks identity before writing a body that sets one ([plat5 `docs/guides/write-a-service.md`](https://github.com/plat5dev/plat5/blob/master/docs/guides/write-a-service.md#checking-access-outside-a-request)), in `src/access.ts`:

```
POST {IDENTITY_INTERNAL_URL}/access/v1/evaluation
{ "subject":  { "type": "member",  "id": "<assignee_id>" },
  "resource": { "type": "project", "id": "<project_id>" },
  "action":   { "name": "<TASK_ASSIGNEE_PERMISSION>" } }
```

It sends the request's `traceparent` and `X-Request-ID`. After the body (**422**) and, on `PATCH`, the task (**404**), it asks about the project in the path, and then writes or doesn't:

| Identity answers | The API |
|------------------|---------|
| `200 {"decision": true}` | Writes |
| `200 {"decision": false}` | **422** `VALIDATION_ERROR`, `That person can't see this project.`, at `assignee_id`. Nothing written |
| **503** (its Postgres is unavailable), any other status, a body without a boolean `decision`, no answer, or `IDENTITY_INTERNAL_URL` unset | **503** `SERVICE_UNAVAILABLE`, logged with the request id. Nothing written: no answer is no, and the caller retries later |

`null` unassigns and an absent `assignee_id` leaves the task's as it is; neither asks. Anything but a lowercase ULID or `null` is **422** at `assignee_id`.

`TASK_ASSIGNEE_PERMISSION` names the permission, and the API won't start without it. The name is the deployment's, not the code's: the starter's is `project:read`, the permission `services/api.yml` requires to read a project's tasks, so an assignee is someone who can see them. A deployment that renames that permission sets this too; otherwise identity answers `false` for everyone and every assignee is refused. The resource is the `project` kind, its id from the path, following `plat5.yml`'s kinds.

## Following the lifecycle

The API follows identity's lifecycle log, `GET /internal/events` on `IDENTITY_INTERNAL_URL`, in `src/lifecycle.ts`. What the log guarantees and how a service follows it: [plat5 `docs/concepts/lifecycle.md`](https://github.com/plat5dev/plat5/blob/master/docs/concepts/lifecycle.md#following-the-log); its params and answers: [`docs/reference/api/internal.md`](https://github.com/plat5dev/plat5/blob/master/docs/reference/api/internal.md#lifecycle-events).

It asks only for the two events it acts on, `?types=node.purged,user.deleted`:

| Event | The API |
|-------|---------|
| `node.purged` with `kind: project` | Deletes that project's tasks. A purged organization's projects are purged with it, each with its own event |
| `user.deleted` | Deletes that person's profile |

Every other event needs nothing. Tasks are authored, so `member.removed` keeps them; there's no background work to stop on `node.deleted`; and a profile is made on the person's first call, not on `user.created`.

One cursor, the last event `id` acted on, is kept in SQLite beside the data it cleans up (`feed_cursors`, one row). With no cursor it reads from the log's first event. It asks with `&after=<cursor>`, and identity waits for an event. A page's deletes and the new cursor commit in one transaction, then it asks again at once; after a **204** (nothing came) it asks again at once; after an error (a **503** while identity's Postgres is unavailable, any other status, or no answer) it logs it and asks again in 5 seconds, from the same cursor. Deleting a purged project's tasks or a deleted person's profile again changes nothing, so an event read twice is harmless. With `IDENTITY_INTERNAL_URL` unset the log isn't read, and the API says so once at boot.

To replay the log, from its first event (after restoring the database, or fixing a handler), stop the API, delete the cursor, and start it:

```bash
docker compose stop api
docker compose run --rm --no-deps api sqlite3 /data/app.db 'DELETE FROM feed_cursors'
docker compose start api
```

It logs `following the lifecycle log from its first event`, then each page it reads. Against another database the SQL is the same: `DELETE FROM feed_cursors` in the file at `DATABASE_PATH`.

## Lists

The task list pages like every Plat5 list ([plat5 `docs/reference/lists.md`](https://github.com/plat5dev/plat5/blob/master/docs/reference/lists.md)). `src/pagination.ts` is their schema.

| | |
|---|---|
| `limit` | Default 50, max 100. Over the max is clamped. Under 1 or not a whole number (digits only) → **422** |
| `starting_after` | The `id` of the last item on the previous page. Not a lowercase ULID → **422**; both wrong, both are named, `limit` first |
| Answer | `{"tasks": [...], "has_more": false}`, in `id` order (oldest first) |

## Audit details

The gateway records each write before it reaches this service. Each write says what it changed on `X-Plat5-Audit-Details`, and a create names its new id on `X-Plat5-Audit-Created` ([plat5 `docs/concepts/audit.md`](https://github.com/plat5dev/plat5/blob/master/docs/concepts/audit.md#what-a-service-adds)). The gateway stores them with the event and strips them before the client sees the response. `src/audit.ts` builds and encodes them.

| Write | Details |
|-------|---------|
| `POST` tasks | `task_id`, `title`, `status`, `assignee_id`. Created: the task id |
| `PATCH` a task | `title`, `status`, `assignee_id` as changes |
| `PUT` the profile | `bio` as a change |
| `DELETE` a task | None: the route and its path say what happened |

A change is `{"from": …, "to": …}`, only for fields that changed; a write that changed nothing sends no header. Never put a secret in either header.

## Run it

You need Docker and the `plat5` CLI.

```bash
plat5 start
```

`plat5 start` runs Plat5 and its modules, applies `plat5.yml`, builds and runs the API from `docker-compose.yml`, and seeds a dev person with an org, `Dev` (`/orgs/dev`), and a personal key. It prints the links, logins and key; `plat5 status` prints them again. Every credential is sent as `Authorization: Bearer`:

```bash
KEY=plat5-k-2-…   # from plat5 status
curl -X POST localhost:5400/orgs/dev/projects -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{"display_name": "Demo"}'
curl -X POST localhost:5400/orgs/dev/projects/demo/tasks -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{"title": "Ship it"}'
curl localhost:5400/orgs/dev/projects/demo/tasks -H "Authorization: Bearer $KEY"
curl -X PUT localhost:5400/user/profile -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{"bio": "Hello"}'
```

To run the API on your own machine instead (your debugger, your editor's runner):

```bash
plat5 start -x app
npm install
TASK_ASSIGNEE_PERMISSION=project:read npm run dev
```

`-x app` runs everything but the API, and points the gateway's `api` at your machine, so the API must listen on port 3000. Identity's internal port isn't published there, so in this mode the lifecycle log isn't read and a task with an assignee is a **503**.

`plat5 stop` stops it all; data is kept.

## Build your first feature

A `GET …/stats` for a project, end to end.

**1. Add the handler.** A plugin in `src/stats/routes.ts` with a route on `/projects/:project_id/stats`, registered in `src/app.ts` beside `taskRoutes` (copy `src/tasks/`). Give it a `schema` (`params`, and a `querystring` or `body` if it takes one: TypeBox, as in `src/schemas.ts`), and read `req.params.project_id`. Don't check who called: the front door did, and the path is the answer. Throw the errors in `src/errors.ts`; a body's sentences go in the route's `config.messages`.

**2. Route it.** Add it to `services/api.yml`, in the `project` scope. The path is relative to the project; `upstream_prefix` makes its upstream `/projects/{project.id}/stats`:

```yaml
        - path: /stats
          methods:
            GET: { required_permissions: [stats:read] }
```

**3. Grant the permission.** Add `stats:read` to a role's `permissions` in `plat5.yml` (`developer`, say). `admin`'s `"*"` already holds it.

**4. Apply.** `plat5 apply`, or `plat5 start` again. Nothing restarts.

**5. Call it.** `curl localhost:5400/orgs/dev/projects/demo/stats -H "Authorization: Bearer $KEY"`. With a credential whose roles there lack `stats:read`: **403** `FORBIDDEN`, with `required_permissions` in `details`.

**6. Writes: say what changed.** For a `POST`, `PUT`, `PATCH` or `DELETE`, set the audit details where the old and new values are in hand ([Audit details](#audit-details)), and read the author from `X-Plat5-Member-Id` if the record has one.

**7. Let the operator plane see it.** Add the API's own path, `/projects/{project_id}/stats` with `node: project_id`, to the operator plane's route file beside the routes from `routes.operator.yml`.

## Commands

```bash
TASK_ASSIGNEE_PERMISSION=project:read npm run dev    # node --watch, reading .env if there is one
TASK_ASSIGNEE_PERMISSION=project:read npm start      # node src/main.ts
npm run check                                        # tsc: types only
npm test                                             # node --test
```

## Ports

| Port | Env | Purpose |
|------|-----|---------|
| 3000 | `PORT` | Public API (+ `/docs` OpenAPI) |
| 3001 | `INTERNAL_PORT` | `/health/live`, `/health/ready`, `/metrics` |

## Environment

See `.env.example`. `npm run dev` reads `.env` (`node --env-file-if-exists`); `npm start` reads only the environment.

| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` | `3000` | Public. Not a port number → the API exits at boot |
| `INTERNAL_PORT` | `3001` | Health + `/metrics` |
| `DATABASE_PATH` | `./data/app.db` | SQLite file |
| `IDENTITY_INTERNAL_URL` | unset | Identity's internal base URL, for its lifecycle log and the assignee check. The compose file sets `http://identity:3001`. Unset → the log isn't read, and a task with an assignee is a **503** |
| `TASK_ASSIGNEE_PERMISSION` | required | The permission an assignee needs on the task's project ([Checking an assignee](#checking-an-assignee)). The compose file and `.env.example` set `project:read`. Unset or empty → the API exits at boot |
| `OTEL_SERVICE_NAME` | `api` | Resource `service.name` |
| `OTEL_SERVICE_NAMESPACE` | `api` | Resource `service.namespace` |
| `OTEL_SERVICE_VERSION` | the build's `VERSION`, else `dev` | Resource `service.version` ([resource identity](https://github.com/plat5dev/plat5/blob/master/docs/reference/telemetry.md#resource-identity), [Docker](#docker)) |
| `OTEL_SERVICE_INSTANCE_ID` | `$HOSTNAME`, else `api-local` | Resource `service.instance.id` |
| `DEPLOYMENT_ENV` / `OTEL_DEPLOYMENT_ENV` | `development` | Resource `deployment.environment` (`OTEL_DEPLOYMENT_ENV` wins) |
| `OTEL_RESOURCE_ATTRIBUTES` | unset | Standard bag: `service.namespace=…,service.version=…,…` (vars above win) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | OTLP base URL. Unset → no OTLP |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | unset | Optional full traces URL |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | unset | Optional full metrics URL |
| `OTEL_TRACES_EXPORTER` | `otlp` when endpoint set | Include `otlp` to push traces |
| `OTEL_METRICS_EXPORTER` | `otlp` when endpoint set | Set `prometheus` to push-off; `/metrics` always on |
| `OTEL_EXPORTER_OTLP_PROTOCOL` (and `_TRACES_`, `_METRICS_`) | `http/protobuf` | The only one supported |
| `OTEL_EXPORTER_OTLP_HEADERS` | unset | Headers on every export (e.g. a collector's auth) |
| `OTEL_METRIC_EXPORT_INTERVAL` | `60000` | ms (OTLP metrics only) |
| `OTEL_TRACES_SAMPLER_RATIO` | `1` | Trace sampling ratio, `0` to `1`; parent-based |
| `OTEL_SDK_DISABLED` | `false` | `true` → no OTLP; stdout + `/metrics` remain |

A telemetry variable that is set but invalid stops the API at boot, naming it ([invalid values](https://github.com/plat5dev/plat5/blob/master/docs/reference/telemetry.md#invalid-values)).

## Telemetry

Contract: Plat5 [`docs/reference/telemetry.md`](https://github.com/plat5dev/plat5/blob/master/docs/reference/telemetry.md).

| Signal | Path |
|--------|------|
| Logs | JSON stdout; access line per request, with `request_id`, and `node_id` and `member_id` on task routes or `user_id` on the profile ([logs](https://github.com/plat5dev/plat5/blob/master/docs/reference/telemetry.md#logs)) |
| Metrics scrape | Prometheus `/metrics` on `INTERNAL_PORT`: the HTTP, DB and process series, each written once to the OpenTelemetry meter (`src/metrics.ts`) |
| Traces | OTLP HTTP when endpoint set (default); W3C Trace Context, `traceparent` in and on to identity; HTTP server spans as [the contract](https://github.com/plat5dev/plat5/blob/master/docs/reference/telemetry.md#http-server-spans) has them (`src/observability.ts`: `{method} {route}`, `Error` on a 5xx only), `src/redact.ts` redacting `url.query`; the same ids as `plat5.node_id`, `plat5.member_id`, `plat5.user_id` |
| Metrics OTLP | On when endpoint set (default): the same series, process ones included; set `OTEL_METRICS_EXPORTER=prometheus` to opt out |

```bash
# traces and metrics pushed: don't also scrape /metrics into the same backend
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 npm run dev

# traces pushed, metrics scraped (no double count)
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 OTEL_METRICS_EXPORTER=prometheus npm run dev
```

Under `plat5 start`, the compose file gets `OTEL_EXPORTER_OTLP_ENDPOINT` from the CLI when the observability module is on. Running on your own machine, set it yourself. Without it there's no OTLP: stdout logs and `/metrics` only, and the request's `traceparent` still goes on to identity.

An export that fails, the collector unreachable say, is an `error` line, `telemetry error` with the cause in `error_message`, each time it fails; the API keeps serving ([invalid values](https://github.com/plat5dev/plat5/blob/master/docs/reference/telemetry.md#invalid-values)).

Health and `/metrics` are on the internal server, not traced.

## Layout

```
src/
  main.ts              # public + internal servers, SQLite, the lifecycle reader
  app.ts               # the public API: Fastify, its JSON parser, error and 404 handlers, OpenAPI, routes
  schemas.ts           # TypeBox schemas, each field's sentences
  validation.ts        # what fails a schema, as Plat5's 422
  observability.ts     # each request's span, metrics and log line
  internal.ts          # the internal port: health, /metrics
  config.ts            # env → AppConfig, the OTel resource among it
  telemetry.ts         # OpenTelemetry: the meter's readers, the tracer, the propagator
  metrics.ts           # the HTTP, DB and process series
  version.ts           # service.version: the build's VERSION, written by the Dockerfile; dev without one
  db.ts                # node:sqlite open + schema, timed operations, transactions
  errors.ts            # Plat5 error envelope
  audit.ts             # X-Plat5-Audit-Details / -Created
  pagination.ts        # limit, starting_after, has_more
  lifecycle.ts         # identity's lifecycle log: purged projects, deleted accounts
  access.ts            # identity's access evaluation: assignees
  redact.ts            # url.query redaction
  log.ts               # a JSON log line
  profiles/ tasks/     # the API: routes + store
  *.test.ts            # tests, beside what they test
  testing.ts           # for tests: the API on an in-memory database, a fake identity
plat5.yml services/    # the deployment's config
plat5.dev.yml          # plat5 start
routes.operator.yml    # the operator plane's routes on this API
plat5.template.yml     # the starter's manifest
```

## Docker

```bash
docker compose up --build
docker build --target prod --build-arg VERSION=v1.2.3 -t api .   # service.version v1.2.3; dev without VERSION
```

- `local` target: hot reload, source mount
- `prod` target: non-root, `npm ci --omit=dev`, the TypeScript run as it is
