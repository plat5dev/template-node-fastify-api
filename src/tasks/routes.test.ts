import { propagation } from "@opentelemetry/api"
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"
import { core } from "@opentelemetry/sdk-node"
import Fastify from "fastify"
import assert from "node:assert/strict"
import { createServer, type IncomingHttpHeaders } from "node:http"
import type { AddressInfo } from "node:net"
import { test, type TestContext } from "node:test"
import { AccessClient } from "../access.js"
import { CREATED_HEADER, DETAILS_HEADER } from "../audit.js"
import { connect, migrate } from "../db.js"
import { registerObservability } from "../middleware/observability.js"
import type { Task } from "../schemas/common.js"
import { MEMBER_HEADER, PROJECT_HEADER, registerTaskRoutes } from "./routes.js"
import { TasksStore } from "./store.js"

// initTelemetry's propagator when nothing exports traces.
propagation.setGlobalPropagator(new core.W3CTraceContextPropagator())

const environment = "01jd8x3k7q0000000000000000"
const other = "01jd8x3k7q0000000000000001"
const project = "01jd8x3k7q00000000000000pp"
const member = "01jd8x3k7q00000000000000mm"
const assignee = "01jd8x3k7q00000000000000aa"
// Not the starter's, to show the check asks for the configured one.
const permission = "tasks:assignable"

const tasksPath = `/environments/${environment}/tasks`
/** A write that sets the assignee. */
const assigning = JSON.stringify({ title: "Other", assignee_id: assignee })

/** What identity should be asked for an assignee on the project. */
const evaluation = (assigneeId: string) => ({
  subject: { type: "member", id: assigneeId },
  resource: { type: "project", id: project },
  action: { name: permission }
})

/**
 * Identity, answering every access evaluation with `status` and `body` (a decision of true
 * until told otherwise), and keeping each body and its headers.
 */
const serveIdentity = async (t: TestContext) => {
  const identity = {
    url: "",
    status: 200,
    body: `{"decision":true}`,
    asked: [] as unknown[],
    headers: [] as IncomingHttpHeaders[]
  }
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/access/v1/evaluation") {
      return res.writeHead(404).end()
    }
    let sent = ""
    for await (const chunk of req) sent += chunk
    identity.asked.push(JSON.parse(sent))
    identity.headers.push(req.headers)
    res.writeHead(identity.status, { "content-type": "application/json" })
    res.end(identity.body)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => server.close())
  identity.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return identity
}

/** The task routes, with identity allowing every assignee until told otherwise. */
const newApp = async (t: TestContext, opts: { identityUnset?: boolean } = {}) => {
  // Request logs, out of the test output.
  t.mock.method(console, "log", () => {})
  const identity = await serveIdentity(t)
  const db = connect(":memory:")
  migrate(db)
  t.after(() => db.close())
  const app = Fastify().withTypeProvider<TypeBoxTypeProvider>()
  registerObservability(app)
  const access = new AccessClient(opts.identityUnset ? undefined : identity.url)
  registerTaskRoutes(app, new TasksStore(db), access, permission)
  await app.ready()
  t.after(() => app.close())

  /**
   * Sends what the gateway sends on an environment route: the caller's member id and the
   * environment's project id, but for the header in `without`.
   */
  const send = (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    body?: string,
    opts: { without?: string; headers?: Record<string, string> } = {}
  ) => {
    const headers: Record<string, string> = {
      [MEMBER_HEADER]: member,
      [PROJECT_HEADER]: project,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...opts.headers
    }
    if (opts.without) delete headers[opts.without]
    if (body === undefined) return app.inject({ method, url, headers })
    return app.inject({ method, url, headers, payload: body })
  }

  const create = async (environmentId: string, title: string): Promise<Task> => {
    const path = `/environments/${environmentId}/tasks`
    const res = await send("POST", path, JSON.stringify({ title }))
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

  return { identity, send, create, get, list }
}

type ErrorBody = {
  error: {
    code: string
    message: string
    details: { fields?: { path: string; message: string }[] }
  }
}

test("create", async (t) => {
  const { create } = await newApp(t)
  const task = await create(environment, "Launch")
  assert.equal(task.environment_id, environment)
  assert.equal(task.created_by, member)
  assert.equal(task.status, "todo")
  assert.equal(task.assignee_id, null)
  assert.match(task.id, /^[0-9a-z]{26}$/)
})

test("create needs the member, before the body", async (t) => {
  const { send } = await newApp(t)
  for (const body of [`{"title":"Launch"}`, `{"title":""}`, `{`]) {
    const res = await send("POST", tasksPath, body, { without: MEMBER_HEADER })
    assert.equal(res.statusCode, 400, body)
    assert.equal(res.json<ErrorBody>().error.code, "INVALID_REQUEST")
  }
})

test("scoped by environment", async (t) => {
  const { send, create, list } = await newApp(t)
  const task = await create(other, "Elsewhere")
  for (const method of ["GET", "PATCH", "DELETE"] as const) {
    const body = method === "PATCH" ? `{"title":"x"}` : undefined
    const res = await send(method, `${tasksPath}/${task.id}`, body)
    assert.equal(res.statusCode, 404, method)
  }
  assert.deepEqual((await list()).tasks, [])
})

test("list pages", async (t) => {
  const { create, list } = await newApp(t)
  const ids: string[] = []
  for (const title of ["a", "b", "c"]) ids.push((await create(environment, title)).id)

  const first = await list("?limit=2")
  assert.deepEqual(
    first.tasks.map((task) => task.id),
    ids.slice(0, 2)
  )
  assert.equal(first.has_more, true)
  const second = await list(`?limit=2&starting_after=${first.tasks[1]!.id}`)
  assert.deepEqual(
    second.tasks.map((task) => task.id),
    ids.slice(2)
  )
  assert.equal(second.has_more, false)
  const all = await list()
  assert.equal(all.tasks.length, 3)
  assert.equal(all.has_more, false)
})

test("audit details", async (t) => {
  const { send } = await newApp(t)
  const details = (res: { headers: Record<string, unknown> }) => {
    const header = res.headers[DETAILS_HEADER.toLowerCase()]
    return header === undefined ? undefined : JSON.parse(String(header))
  }

  let res = await send("POST", tasksPath, `{"title":"Launch"}`)
  const task = res.json<Task>()
  assert.equal(res.headers[CREATED_HEADER.toLowerCase()], task.id)
  assert.deepEqual(details(res), {
    task_id: task.id,
    title: "Launch",
    status: "todo",
    assignee_id: null
  })

  const path = `${tasksPath}/${task.id}`
  res = await send("PATCH", path, `{"status":"done"}`)
  assert.deepEqual(details(res), { status: { from: "todo", to: "done" } })

  res = await send("PATCH", path, JSON.stringify({ assignee_id: assignee }))
  assert.deepEqual(details(res), { assignee_id: { from: null, to: assignee } })

  res = await send("PATCH", path, `{"status":"done"}`)
  assert.equal(details(res), undefined, "no-op update")

  res = await send("DELETE", path)
  assert.equal(res.statusCode, 204)
  assert.equal(details(res), undefined, "delete")
})

test("create with an assignee", async (t) => {
  const { identity, send, get } = await newApp(t)
  const body = JSON.stringify({ title: "Launch", assignee_id: assignee })
  const res = await send("POST", tasksPath, body)
  assert.equal(res.statusCode, 201)
  const task = res.json<Task>()
  assert.equal(task.assignee_id, assignee)
  assert.equal((await get(task.id)).assignee_id, assignee)
  // The assignee, on the project from the header, for the configured permission.
  assert.deepEqual(identity.asked, [evaluation(assignee)])
})

test("the evaluation carries the request's X-Request-ID and trace", async (t) => {
  const { identity, send } = await newApp(t)
  const traceId = "0af7651916cd43dd8448eb211c80319c"
  const body = JSON.stringify({ title: "Launch", assignee_id: assignee })
  const res = await send("POST", tasksPath, body, {
    headers: { "x-request-id": "req-1", traceparent: `00-${traceId}-b7ad6b7169203331-01` }
  })
  assert.equal(res.statusCode, 201)
  assert.equal(identity.headers[0]?.["x-request-id"], "req-1")
  assert.match(String(identity.headers[0]?.traceparent), new RegExp(`^00-${traceId}-`))
})

test("a refused assignee is a 422, and nothing is written", async (t) => {
  const { identity, send, create, list } = await newApp(t)
  const task = await create(environment, "Launch")
  identity.body = `{"decision":false}`

  const want = "That person can't see this project."
  for (const [method, url] of [
    ["POST", tasksPath],
    ["PATCH", `${tasksPath}/${task.id}`]
  ] as const) {
    const res = await send(method, url, assigning)
    assert.equal(res.statusCode, 422, method)
    const { error } = res.json<ErrorBody>()
    assert.equal(error.code, "VALIDATION_ERROR")
    assert.equal(error.message, want)
    assert.deepEqual(error.details.fields, [{ path: "assignee_id", message: want }])
  }
  // Nothing written: no second task, and the first unchanged.
  const { tasks } = await list()
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0]!.title, "Launch")
  assert.equal(tasks[0]!.assignee_id, null)
  assert.deepEqual(identity.asked, [evaluation(assignee), evaluation(assignee)])
})

for (const [name, status, answer, identityUnset] of [
  ["identity answers 500", 500, `{"error":{}}`, false],
  ["identity answers without a decision", 200, `{}`, false],
  ["IDENTITY_INTERNAL_URL unset", 200, `{"decision":true}`, true]
] as const) {
  test(`no answer is a 503, and nothing is written: ${name}`, async (t) => {
    const { identity, send, create, list } = await newApp(t, { identityUnset })
    const task = await create(environment, "Launch")
    identity.status = status
    identity.body = answer

    for (const [method, url] of [
      ["POST", tasksPath],
      ["PATCH", `${tasksPath}/${task.id}`]
    ] as const) {
      const res = await send(method, url, assigning)
      assert.equal(res.statusCode, 503, method)
      assert.equal(res.json<ErrorBody>().error.code, "SERVICE_UNAVAILABLE")
    }
    const { tasks } = await list()
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0]!.title, "Launch")
    assert.equal(tasks[0]!.assignee_id, null)
  })
}

test("update an assignee", async (t) => {
  const { identity, send, create, get } = await newApp(t)
  const task = await create(environment, "Launch")
  const path = `${tasksPath}/${task.id}`

  let res = await send("PATCH", path, JSON.stringify({ assignee_id: assignee }))
  assert.equal(res.statusCode, 200)
  assert.equal(res.json<Task>().assignee_id, assignee)
  assert.deepEqual(identity.asked, [evaluation(assignee)])

  // The same member again is still checked.
  res = await send("PATCH", path, JSON.stringify({ assignee_id: assignee }))
  assert.equal(res.statusCode, 200)
  assert.equal(identity.asked.length, 2)

  // Absent leaves the assignee, and null unassigns: neither asks identity.
  res = await send("PATCH", path, `{"title":"Renamed"}`)
  assert.equal(res.statusCode, 200)
  assert.equal(res.json<Task>().assignee_id, assignee)
  res = await send("PATCH", path, `{"assignee_id":null}`)
  assert.equal(res.statusCode, 200)
  assert.equal(res.json<Task>().assignee_id, null)
  assert.equal((await get(task.id)).assignee_id, null)
  assert.equal(identity.asked.length, 2)
})

test("no assignee, no check", async (t) => {
  const { identity, send, list } = await newApp(t)
  // Without an assignee, the project header isn't needed either.
  for (const body of [`{"title":"a"}`, `{"title":"b","assignee_id":null}`]) {
    const res = await send("POST", tasksPath, body, { without: PROJECT_HEADER })
    assert.equal(res.statusCode, 201, body)
    assert.equal(res.json<Task>().assignee_id, null)
  }
  const task = (await list()).tasks[0]!
  for (const body of [`{"status":"done"}`, `{"assignee_id":null}`]) {
    const path = `${tasksPath}/${task.id}`
    const res = await send("PATCH", path, body, { without: PROJECT_HEADER })
    assert.equal(res.statusCode, 200, body)
  }
  assert.deepEqual(identity.asked, [])
})

test("an assignee needs the project", async (t) => {
  const { identity, send, create, list } = await newApp(t)
  const task = await create(environment, "Launch")
  for (const [method, url] of [
    ["POST", tasksPath],
    ["PATCH", `${tasksPath}/${task.id}`]
  ] as const) {
    const res = await send(method, url, assigning, { without: PROJECT_HEADER })
    assert.equal(res.statusCode, 400, method)
    assert.equal(res.json<ErrorBody>().error.code, "INVALID_REQUEST")
  }
  const { tasks } = await list()
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0]!.title, "Launch")
  assert.deepEqual(identity.asked, [])
})

test("a bad assignee id is a 422 at assignee_id", async (t) => {
  const { identity, send, create } = await newApp(t)
  const task = await create(environment, "Launch")
  for (const value of [`""`, `"someone"`, `"01JD8X3K7Q00000000000000AA"`, `5`, `{}`]) {
    for (const [method, url] of [
      ["POST", tasksPath],
      ["PATCH", `${tasksPath}/${task.id}`]
    ] as const) {
      const res = await send(method, url, `{"title":"Other","assignee_id":${value}}`)
      assert.equal(res.statusCode, 422, `${method} ${value}`)
      const { error } = res.json<ErrorBody>()
      assert.equal(error.code, "VALIDATION_ERROR")
      assert.deepEqual(error.details.fields, [
        { path: "assignee_id", message: "That doesn't look right." }
      ])
    }
  }
  assert.deepEqual(identity.asked, [])
})

test("update order: the body, then the task, then identity", async (t) => {
  const { identity, send } = await newApp(t)
  const missing = `${tasksPath}/01jd8x3k7q00000000000000zz`
  const assign = JSON.stringify({ assignee_id: assignee })

  const badBody = JSON.stringify({ title: "", assignee_id: assignee })
  let res = await send("PATCH", missing, badBody)
  assert.equal(res.statusCode, 422, "bad body on a missing task")
  res = await send("PATCH", missing, assign)
  assert.equal(res.statusCode, 404, "assign a missing task")
  res = await send("PATCH", missing, assign, { without: PROJECT_HEADER })
  assert.equal(res.statusCode, 404, "assign a missing task without a project")
  assert.deepEqual(identity.asked, [])
})
