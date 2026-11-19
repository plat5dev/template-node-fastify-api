import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { CREATED_HEADER, DETAILS_HEADER, MAX_BYTES } from "./audit.ts"
import type { Task } from "./schemas.ts"
import { MEMBER_HEADER } from "./tasks.ts"
import {
  assertMalformed,
  assertValidationPaths,
  errorOf,
  MEMBER,
  type Method,
  newApp
} from "./testing.ts"

const project = "01jd8x3k7q0000000000000000"
const other = "01jd8x3k7q0000000000000001"
const assignee = "01jd8x3k7q00000000000000aa"
const missingTask = "01jd8x3k7q00000000000000zz"
const permission = "tasks:assignable"
const tasksPath = `/projects/${project}/tasks`
const assigning = JSON.stringify({ title: "Other", assignee_id: assignee })

const evaluation = (assigneeId: string) => ({
  subject: { type: "member", id: assigneeId },
  resource: { type: "project", id: project },
  action: { name: permission }
})

const setup = async (t: TestContext, opts: Parameters<typeof newApp>[1] = {}) => {
  const ctx = await newApp(t, { permission, ...opts })
  const { send } = ctx

  const create = async (projectId: string, title: string): Promise<Task> => {
    const res = await send("POST", `/projects/${projectId}/tasks`, JSON.stringify({ title }))
    assert.equal(res.statusCode, 201)
    return res.json()
  }
  const get = async (taskId: string): Promise<Task> => {
    const res = await send("GET", `${tasksPath}/${taskId}`)
    assert.equal(res.statusCode, 200)
    return res.json()
  }
  const list = async (query = ""): Promise<{ tasks: Task[]; has_more: boolean }> => {
    const res = await send("GET", `${tasksPath}${query}`)
    assert.equal(res.statusCode, 200)
    return res.json()
  }
  const accessLines = () => ctx.logged().filter((line) => line.message === "request completed")
  return { ...ctx, create, get, list, accessLines }
}

const auditDetails = (res: { headers: Record<string, unknown> }) => {
  const header = res.headers[DETAILS_HEADER.toLowerCase()]
  return typeof header === "string" ? JSON.parse(header) : undefined
}

test("create task defaults and requires X-Plat5-Member-Id before reading body", async (t) => {
  const { send, create } = await setup(t)
  const task = await create(project, "  Launch  ")
  assert.equal(task.project_id, project)
  assert.equal(task.title, "Launch")
  assert.equal(task.created_by, MEMBER)
  assert.equal(task.status, "todo")
  assert.equal(task.assignee_id, null)
  assert.match(task.id, /^[0-7][0-9a-hjkmnp-tv-z]{25}$/)

  for (const body of [`{"title":"Launch"}`, `{"title":""}`, `{`]) {
    assertMalformed(await send("POST", tasksPath, body, { without: MEMBER_HEADER }), body)
  }
})

test("tenant isolation: tasks are scoped to project_id", async (t) => {
  const { send, create, list } = await setup(t)
  const task = await create(other, "Elsewhere")
  for (const method of ["GET", "PATCH", "DELETE"] as const) {
    const res = await send(method, `${tasksPath}/${task.id}`, method === "PATCH" ? `{"title":"x"}` : undefined)
    assert.equal(res.statusCode, 404, method)
    assert.deepEqual(errorOf(res).details, { resource: "task", id: task.id })
  }
  assert.deepEqual((await list()).tasks, [])
})

test("pagination: limit, clamping, starting_after, monotonic order, validation", async (t) => {
  const { send, create, list } = await setup(t)
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-28T00:00:00.000Z") })
  const ids: string[] = []
  for (const title of ["a", "b", "c"]) ids.push((await create(project, title)).id)
  t.mock.timers.reset()

  const first = await list("?limit=2")
  assert.deepEqual(first.tasks.map((task) => task.id), ids.slice(0, 2))
  assert.equal(first.has_more, true)

  const second = await list(`?limit=1000&starting_after=${first.tasks[1]!.id}`)
  assert.deepEqual(second.tasks.map((task) => task.id), ids.slice(2))
  assert.equal(second.has_more, false)

  for (const limit of ["0", "-1", "abc", "1.5", ""]) {
    assertValidationPaths(await send("GET", `${tasksPath}?limit=${limit}`), ["limit"], limit)
  }
  for (const after of ["", "nope", "01JD8X3K7Q0000000000000000"]) {
    assertValidationPaths(await send("GET", `${tasksPath}?starting_after=${after}`), ["starting_after"], after)
  }
  assertValidationPaths(
    await send("GET", `${tasksPath}?starting_after=x&limit=x`),
    ["limit", "starting_after"]
  )
})

test("PATCH updates fields, unassigns with null, and skips DB write on no-op", async (t) => {
  let updateCalls = 0
  const ctx = await setup(t)
  const originalUpdate = ctx.db.prepare.bind(ctx.db)
  assert.ok(originalUpdate)

  // Spy via store override to prove no-op PATCH never hits DB or bumps updated_at.
  const tracked = await setup(t, {
    tasks: {
      update: () => {
        updateCalls++
        return true
      }
    }
  })
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-28T00:00:00.000Z") })
  const task = await tracked.create(project, "Launch")
  t.mock.timers.setTime(new Date("2026-10-28T01:00:00.000Z").getTime())

  for (const body of [`{}`, `{"title":null,"status":null}`, `{"title":"  Launch  ","status":"todo"}`]) {
    const res = await tracked.send("PATCH", `${tasksPath}/${task.id}`, body)
    assert.equal(res.statusCode, 200, body)
    const got = res.json<Task>()
    assert.equal(got.updated_at, task.updated_at, `no-op PATCH bumped updated_at: ${body}`)
    assert.equal(auditDetails(res), undefined)
  }
  assert.equal(updateCalls, 0, "no-op PATCH must not write to DB")
  t.mock.timers.reset()

  // Real update + unassign flow.
  const t2 = await ctx.create(project, "Launch")
  const path = `${tasksPath}/${t2.id}`
  let res = await ctx.send("PATCH", path, JSON.stringify({ status: "done", assignee_id: assignee }))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(auditDetails(res), {
    status: { from: "todo", to: "done" },
    assignee_id: { from: null, to: assignee }
  })

  res = await ctx.send("PATCH", path, `{"assignee_id":null}`)
  assert.equal(res.statusCode, 200)
  assert.equal((await ctx.get(t2.id)).assignee_id, null)
  assert.deepEqual(auditDetails(res), { assignee_id: { from: assignee, to: null } })

  // DELETE returns 204 without audit details, then 404.
  res = await ctx.send("DELETE", path)
  assert.equal(res.statusCode, 204)
  assert.equal(auditDetails(res), undefined)
  assert.equal((await ctx.send("DELETE", path)).statusCode, 404)
})

test("audit details: visible ASCII escaping without HTML escaping, capped at 4096 bytes", async (t) => {
  const { send } = await setup(t)
  const res = await send("POST", tasksPath, JSON.stringify({ title: "<é😀&>" }))
  assert.equal(res.statusCode, 201)
  const task = res.json<Task>()
  assert.equal(res.headers[CREATED_HEADER.toLowerCase()], task.id)
  const rawHeader = String(res.headers[DETAILS_HEADER.toLowerCase()])
  assert.ok(rawHeader.includes('"<\\u00e9\\ud83d\\ude00&>"'), rawHeader)
  assert.equal(rawHeader.includes("\\u003c"), false)
  assert.ok(rawHeader.length <= MAX_BYTES)
  assert.deepEqual(JSON.parse(rawHeader), {
    task_id: task.id,
    title: "<é😀&>",
    status: "todo",
    assignee_id: null
  })
})

test("assignee access evaluation: allow, deny (422), fail-closed (503), and active trace propagation", async (t) => {
  const { identity, send, create, list, logged } = await setup(t)
  const traceId = "0af7651916cd43dd8448eb211c80319c"
  const gatewaySpanId = "b7ad6b7169203331"

  // Allowed with traceparent & X-Request-ID forwarded via active OTel context.
  let res = await send("POST", tasksPath, assigning, {
    headers: { "x-request-id": "req-1", traceparent: `00-${traceId}-${gatewaySpanId}-01` }
  })
  assert.equal(res.statusCode, 201)
  assert.deepEqual(identity.asked, [evaluation(assignee)])
  assert.equal(identity.headers[0]?.["x-request-id"], "req-1")
  const forwardedTp = String(identity.headers[0]?.traceparent)
  assert.match(forwardedTp, new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`))
  // Downstream receives our local server span_id, not the incoming gateway span_id.
  assert.notEqual(forwardedTp.split("-")[2], gatewaySpanId)

  // Denied -> 422 without writing.
  const task = await create(project, "Launch")
  identity.body = `{"decision":false}`
  res = await send("PATCH", `${tasksPath}/${task.id}`, assigning)
  assertValidationPaths(res, ["assignee_id"])
  assert.equal((await list()).tasks.find((item) => item.id === task.id)?.assignee_id, null)

  // Unavailable -> 503 without writing, logged with request_id.
  identity.status = 503
  identity.body = `{"error":{"code":"SERVICE_UNAVAILABLE"}}`
  res = await send("POST", tasksPath, assigning, { headers: { "x-request-id": "req-503" } })
  assert.equal(res.statusCode, 503)
  assert.equal(errorOf(res).code, "SERVICE_UNAVAILABLE")
  assert.equal(errorOf(res).request_id, "req-503")
  assert.ok(logged().some((l) => l.message === "access evaluation failed" && l.request_id === "req-503"))

  // Unset IDENTITY_INTERNAL_URL -> 503.
  const noId = await setup(t, { identityUnset: true })
  assert.equal((await noId.send("POST", tasksPath, assigning)).statusCode, 503)
})

test("active OTel context survives JSON body parsing over a real HTTP socket", async (t) => {
  const { app, identity } = await setup(t)
  const address = await app.listen({ port: 0, host: "127.0.0.1" })
  const traceId = "1af7651916cd43dd8448eb211c80319c"
  const gatewaySpanId = "c7ad6b7169203331"

  const res = await fetch(`${address}${tasksPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-plat5-project-id": project,
      "x-plat5-member-id": MEMBER,
      "x-request-id": "req-http",
      traceparent: `00-${traceId}-${gatewaySpanId}-01`
    },
    body: assigning
  })
  assert.equal(res.status, 201)
  const forwardedTp = String(identity.headers[0]?.traceparent)
  assert.match(forwardedTp, new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`))
  assert.notEqual(forwardedTp.split("-")[2], gatewaySpanId)
})

test("validation: title code points, status, assignee_id, unknown fields, malformed requests", async (t) => {
  const { send, create, identity } = await setup(t)
  const task = await create(project, "Launch")

  // Multi-byte code points: 255 emoji ok (even padded), 256 rejected.
  assert.equal(
    (await send("POST", tasksPath, JSON.stringify({ title: ` ${"😀".repeat(255)} ` }))).statusCode,
    201
  )
  assertValidationPaths(
    await send("POST", tasksPath, JSON.stringify({ title: "😀".repeat(256) })),
    ["title"]
  )
  assertValidationPaths(await send("POST", tasksPath, JSON.stringify({ title: "   " })), ["title"])
  assertValidationPaths(await send("POST", tasksPath, `{}`), ["title"])
  assertValidationPaths(
    await send("POST", tasksPath, JSON.stringify({ title: 123, status: "bad", assignee_id: "x" })),
    ["title", "status", "assignee_id"]
  )
  assertValidationPaths(
    await send("POST", tasksPath, JSON.stringify({ title: "ok", extra: 1 })),
    ["extra"]
  )

  // Validation happens before 404 and before identity evaluation.
  assert.equal(
    (await send("PATCH", `${tasksPath}/${missingTask}`, JSON.stringify({ title: "", assignee_id: assignee })))
      .statusCode,
    422
  )
  assert.equal(
    (await send("PATCH", `${tasksPath}/${missingTask}`, JSON.stringify({ assignee_id: assignee })))
      .statusCode,
    404
  )
  assert.deepEqual(identity.asked, [])

  // Malformed content-type / JSON / missing body -> 400.
  for (const [body, opts] of [
    [`{"title":"x"}`, { without: "content-type" }],
    [`{"title":"x"}`, { headers: { "content-type": "text/plain" } }],
    ["", {}],
    ["{", {}],
    [undefined, {}]
  ] as const) {
    assertMalformed(await send("POST", tasksPath, body, opts))
  }
  assertValidationPaths(await send("POST", tasksPath, `["not-an-object"]`), ["body"])
  assertMalformed(await send("GET", `${tasksPath}/%E0%A4%A`))
})

test("structured Pino request logs, 404/500 envelopes, and OpenAPI docs", async (t) => {
  const { send, accessLines } = await setup(t)
  const user = "01jd8x3k7q00000000000000u1"
  const traceId = "2af7651916cd43dd8448eb211c80319c"
  const gatewaySpanId = "d7ad6b7169203331"

  await send("GET", tasksPath, undefined, {
    headers: { traceparent: `00-${traceId}-${gatewaySpanId}-01` }
  })
  await send("GET", `${tasksPath}/${missingTask}`, undefined, { headers: { "x-request-id": "req-2" } })
  await send("GET", `/users/${user}/profile`)
  const notFoundRes = await send("PUT" as Method, `${tasksPath}/${missingTask}`, "{}")
  assert.equal(notFoundRes.statusCode, 404)

  const [ok, missing, profileLog, unknown] = accessLines()
  assert.equal(ok?.level, "info")
  assert.equal(ok?.route, "/projects/:project_id/tasks")
  assert.equal(ok?.node_id, project)
  assert.equal(ok?.member_id, MEMBER)
  assert.equal("request_id" in ok!, false)
  assert.equal(ok?.trace_id, traceId)
  assert.match(String(ok?.span_id), /^[0-9a-f]{16}$/)
  assert.notEqual(ok?.span_id, gatewaySpanId)
  assert.equal(typeof ok?.duration_ms, "number")
  assert.equal(typeof ok?.timestamp, "string")

  assert.equal(missing?.level, "warn")
  assert.equal(missing?.request_id, "req-2")
  assert.equal(profileLog?.user_id, user)
  assert.equal(unknown?.route, "unknown")

  // Unexpected 500 never leaks internal error details.
  const broken = await setup(t, {
    tasks: {
      list: () => {
        throw new Error("SQLITE_BUSY: secret path")
      }
    }
  })
  const errRes = await broken.send("GET", tasksPath, undefined, { headers: { "x-request-id": "req-5" } })
  assert.equal(errRes.statusCode, 500)
  assert.deepEqual(errRes.json(), {
    error: {
      type: "api_error",
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred.",
      request_id: "req-5",
      details: null
    }
  })

  // OpenAPI JSON and Swagger UI.
  const specRes = await send("GET", "/openapi.json")
  assert.equal(specRes.statusCode, 200)
  const spec = specRes.json<{ info: { version: string }; paths: Record<string, unknown> }>()
  assert.equal(spec.info.version, "test")
  assert.ok("/projects/{project_id}/tasks" in spec.paths)
  assert.ok("/users/{user_id}/profile" in spec.paths)
  assert.equal((await send("GET", "/docs")).statusCode < 400, true)
})
