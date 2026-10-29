import { propagation } from "@opentelemetry/api"
import { core } from "@opentelemetry/sdk-node"
import assert from "node:assert/strict"
import { createServer, type IncomingHttpHeaders } from "node:http"
import type { AddressInfo } from "node:net"
import { test, type TestContext } from "node:test"
import { AccessClient } from "../access.js"
import { buildApp } from "../app.js"
import { CREATED_HEADER, DETAILS_HEADER } from "../audit.js"
import { connect, migrate } from "../db.js"
import { ProfilesStore } from "../profiles/store.js"
import type { Task } from "../schemas/common.js"
import { MEMBER_HEADER, PROJECT_HEADER } from "./routes.js"
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
  const logs = t.mock.method(console, "log", () => {})
  const identity = await serveIdentity(t)
  const db = connect(":memory:")
  migrate(db)
  t.after(() => db.close())
  const store = new TasksStore(db)
  const app = await buildApp({
    tasks: store,
    profiles: new ProfilesStore(db),
    access: new AccessClient(opts.identityUnset ? undefined : identity.url),
    assigneePermission: permission
  })
  t.after(() => app.close())

  /**
   * Sends what the gateway sends on an environment route: the caller's member id and the
   * environment's project id, but for the header in `without`.
   */
  const send = (
    method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT" | "OPTIONS" | "HEAD",
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

  /** The request log lines written so far. */
  const accessLines = () =>
    logs.mock.calls
      .map((call) => JSON.parse(String(call.arguments[0])) as Record<string, unknown>)
      .filter((line) => line.message === "request completed")

  return { identity, send, create, get, list, app, db, store, accessLines }
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

// Parity with the Go starter: each test below pins one behavior the two share.

const FALLBACK = "That doesn't look right."

/** The 422 for one field. */
const assertField = (
  res: { statusCode: number; json: <T>() => T },
  path: string,
  message: string,
  label = ""
) => {
  assert.equal(res.statusCode, 422, label)
  const { error } = res.json<ErrorBody>()
  assert.equal(error.code, "VALIDATION_ERROR", label)
  assert.equal(error.message, message, label)
  assert.deepEqual(error.details.fields, [{ path, message }], label)
}

test("title and status errors, word for word", async (t) => {
  const { send, create } = await newApp(t)
  const task = await create(environment, "Launch")
  const taskPath = `${tasksPath}/${task.id}`
  for (const [method, url] of [
    ["POST", tasksPath],
    ["PATCH", taskPath]
  ] as const) {
    for (const title of ["", "   ", "\u3000\u0085"]) {
      const res = await send(method, url, JSON.stringify({ title }))
      assertField(res, "title", "Title is required.", `${method} ${JSON.stringify(title)}`)
    }
    let res = await send(method, url, JSON.stringify({ title: "x".repeat(256) }))
    assertField(res, "title", "Title is too long.", method)
    for (const status of ["TODO", "in progress", " done", ""]) {
      res = await send(method, url, JSON.stringify({ title: "Launch", status }))
      assertField(res, "status", "Status must be todo, in progress, or done.", status)
    }
  }
  // A create without a title.
  for (const body of [`{}`, `{"title":null}`, `null`]) {
    const res = await send("POST", tasksPath, body)
    assertField(res, "title", "Title is required.", body)
  }
})

test("titles are trimmed of Unicode white space, as Go's strings.TrimSpace", async (t) => {
  const { send, create } = await newApp(t)
  let res = await send("POST", tasksPath, JSON.stringify({ title: " \t\u00a0Launch\u0085\u3000 " }))
  assert.equal(res.statusCode, 201)
  assert.equal(res.json<Task>().title, "Launch")
  // U+FEFF isn't white space to Go.
  res = await send("POST", tasksPath, JSON.stringify({ title: "\ufeffLaunch" }))
  assert.equal(res.json<Task>().title, "\ufeffLaunch")
  const task = await create(environment, "Launch")
  res = await send("PATCH", `${tasksPath}/${task.id}`, JSON.stringify({ title: "  Renamed  " }))
  assert.equal(res.statusCode, 200)
  assert.equal(res.json<Task>().title, "Renamed")
})

test("a title's limit counts characters, not UTF-16 units", async (t) => {
  const { send } = await newApp(t)
  for (const [title, ok] of [
    ["é".repeat(255), true],
    ["😀".repeat(255), true],
    ["é".repeat(256), false],
    ["😀".repeat(256), false]
  ] as const) {
    const res = await send("POST", tasksPath, JSON.stringify({ title }))
    if (ok) assert.equal(res.statusCode, 201, title.slice(0, 2))
    else assertField(res, "title", "Title is too long.", title.slice(0, 2))
  }
})

test("DELETE never reads its body", async (t) => {
  const { send, create } = await newApp(t)
  for (const [contentType, body] of [
    ["application/json", ""],
    ["application/json", "{"],
    ["text/plain", "hello"],
    ["not a type", "{}"],
    [undefined, "x"]
  ] as const) {
    const task = await create(environment, "Launch")
    const res = await send(
      "DELETE",
      `${tasksPath}/${task.id}`,
      body,
      contentType === undefined
        ? { without: "content-type" }
        : { headers: { "content-type": contentType } }
    )
    assert.equal(res.statusCode, 204, `${contentType} ${body}`)
  }
})

test("a known path in another method, or OPTIONS, is the unknown route's 404", async (t) => {
  const { send, create } = await newApp(t)
  const task = await create(environment, "Launch")
  const taskPath = `${tasksPath}/${task.id}`
  for (const [method, url] of [
    ["PUT", taskPath],
    ["POST", taskPath],
    ["DELETE", tasksPath],
    ["PATCH", tasksPath],
    ["PATCH", `/users/${member}/profile`],
    ["OPTIONS", tasksPath],
    ["OPTIONS", taskPath],
    ["GET", "/nope"],
    ["GET", `/users/${member}`]
  ] as const) {
    const res = await send(method, url, method === "OPTIONS" || method === "GET" ? undefined : "{}", {
      headers: { "x-request-id": "req-9" }
    })
    assert.equal(res.statusCode, 404, `${method} ${url}`)
    assert.equal(res.headers.allow, undefined, `${method} ${url}`)
    assert.deepEqual(res.json(), {
      error: {
        type: "invalid_request_error",
        code: "NOT_FOUND",
        message: "Resource not found.",
        request_id: "req-9",
        details: { resource: "resource", id: null }
      }
    })
  }
  // HEAD on a GET route is the GET's answer, without a body; a trailing slash is the same route.
  let res = await send("HEAD", tasksPath)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body, "")
  res = await send("GET", `${tasksPath}/`)
  assert.equal(res.statusCode, 200)
})

test("an unexpected error is the fallback 500, never its own text", async (t) => {
  const { send, store } = await newApp(t)
  t.mock.method(store, "listByEnvironment", () => {
    throw Object.assign(new Error("SQLITE_BUSY: database is locked at /data/app.db"), {
      statusCode: 418
    })
  })
  const res = await send("GET", tasksPath)
  assert.equal(res.statusCode, 500)
  assert.deepEqual(res.json(), {
    error: {
      type: "api_error",
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred.",
      request_id: null,
      details: null
    }
  })
})

test("a body not sent as JSON is a 422 at body, and nothing is written", async (t) => {
  const { send, create, list } = await newApp(t)
  const task = await create(environment, "Launch")
  const cases: [contentType: string | undefined, body: string][] = [
    [undefined, `{"title":"Other"}`],
    [undefined, ""],
    ["text/plain", `{"title":"Other"}`],
    ["text/plain", ""],
    ["application/x-www-form-urlencoded", "title=Other"],
    ["application/jsonx", `{"title":"Other"}`],
    ["", `{"title":"Other"}`],
    ["not a type", `{"title":"Other"}`]
  ]
  for (const [contentType, body] of cases) {
    for (const [method, url] of [
      ["POST", tasksPath],
      ["PATCH", `${tasksPath}/${task.id}`]
    ] as const) {
      const res = await send(
        method,
        url,
        body,
        contentType === undefined
          ? { without: "content-type" }
          : { headers: { "content-type": contentType } }
      )
      assertField(res, "body", FALLBACK, `${method} ${contentType} ${body}`)
    }
  }
  const { tasks } = await list()
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0]!.title, "Launch")
})

test("JSON is application/json with any parameters, or application/…+json", async (t) => {
  const { send } = await newApp(t)
  for (const contentType of [
    "application/json; charset=utf-8",
    "Application/JSON",
    "application/json;charset=UTF-8;",
    'application/json; charset="utf-8"',
    "application/merge-patch+json",
    "application/vnd.api+json"
  ]) {
    const res = await send("POST", tasksPath, `{"title":"Launch"}`, {
      headers: { "content-type": contentType }
    })
    assert.equal(res.statusCode, 201, contentType)
  }
})

test("a body that isn't a JSON object is a 422 at body", async (t) => {
  const { send, create } = await newApp(t)
  const task = await create(environment, "Launch")
  for (const body of ["", " ", "{", `{"title":"a"} x`, `[{"title":"a"}]`, `"a"`, "5", "true"]) {
    for (const [method, url] of [
      ["POST", tasksPath],
      ["PATCH", `${tasksPath}/${task.id}`]
    ] as const) {
      assertField(await send(method, url, body), "body", FALLBACK, `${method} ${body}`)
    }
  }
  // null is an empty object: a no-op update.
  const res = await send("PATCH", `${tasksPath}/${task.id}`, "null")
  assert.equal(res.statusCode, 200)
  assert.equal(res.json<Task>().title, "Launch")
})

test("a field of the wrong JSON type is a 422 at body, never coerced", async (t) => {
  const { send, create } = await newApp(t)
  const task = await create(environment, "Launch")
  for (const body of [
    `{"title":123}`,
    `{"title":true}`,
    `{"title":["a"]}`,
    `{"title":"Launch","status":5}`,
    // Every field's type before any field's value.
    `{"title":"","status":5}`
  ]) {
    for (const [method, url] of [
      ["POST", tasksPath],
      ["PATCH", `${tasksPath}/${task.id}`]
    ] as const) {
      assertField(await send(method, url, body), "body", FALLBACK, `${method} ${body}`)
    }
  }
})

test("keys match their fields ignoring case, as Go's decoder", async (t) => {
  const { send } = await newApp(t)
  const res = await send("POST", tasksPath, `{"TITLE":"Launch","Status":"done","other":1}`)
  assert.equal(res.statusCode, 201)
  assert.equal(res.json<Task>().title, "Launch")
  assert.equal(res.json<Task>().status, "done")
})

test("PATCH and DELETE answer 404 when the scoped write finds no row", async (t) => {
  const { send, create, db, store } = await newApp(t)
  // The task is deleted between the read and the write.
  const find = store.findInEnvironment.bind(store)
  t.mock.method(store, "findInEnvironment", (environmentId: string, taskId: string) => {
    const found = find(environmentId, taskId)
    db.prepare(`DELETE FROM tasks WHERE id = ?`).run(taskId)
    return found
  })
  for (const method of ["PATCH", "DELETE"] as const) {
    const task = await create(environment, "Launch")
    const res = await send(method, `${tasksPath}/${task.id}`, method === "PATCH" ? `{"status":"done"}` : undefined)
    assert.equal(res.statusCode, 404, method)
    assert.deepEqual(res.json<{ error: { details: unknown } }>().error.details, {
      resource: "task",
      id: task.id
    })
    assert.equal(res.headers[DETAILS_HEADER.toLowerCase()], undefined, method)
  }
})

test("a body over 1 MiB is a 413 before anything else, on any route", async (t) => {
  const { send } = await newApp(t)
  const big = `{"title":"${"x".repeat(1 << 20)}"}`
  for (const [method, url, without] of [
    ["POST", tasksPath, MEMBER_HEADER],
    ["POST", tasksPath, undefined],
    ["PATCH", `${tasksPath}/01jd8x3k7q00000000000000zz`, undefined],
    ["PUT", `/users/${member}/profile`, undefined],
    ["POST", "/nope", undefined]
  ] as const) {
    const res = await send(method, url, big, without ? { without } : {})
    assert.equal(res.statusCode, 413, `${method} ${url}`)
    assert.equal(res.headers.allow, undefined)
    assert.deepEqual(res.json(), {
      error: {
        type: "invalid_request_error",
        code: "PAYLOAD_TOO_LARGE",
        message: "Request body is too large.",
        request_id: null,
        details: { max_size_bytes: 1048576 }
      }
    })
  }
  // Exactly 1 MiB is read.
  const fits = `{"title":"a","pad":"${"x".repeat((1 << 20) - 22)}"}`
  assert.equal(Buffer.byteLength(fits), 1 << 20)
  assert.equal((await send("POST", tasksPath, fits)).statusCode, 201)
})

test("list parameters, as Go reads them", async (t) => {
  const { send, create } = await newApp(t)
  for (const title of ["a", "b"]) await create(environment, title)
  const count = async (query: string) => {
    const res = await send("GET", `${tasksPath}${query}`)
    assert.equal(res.statusCode, 200, query)
    return res.json<{ tasks: Task[] }>().tasks.length
  }
  assert.equal(await count("?limit=%2B1"), 1, "a sign, as strconv.Atoi takes it")
  assert.equal(await count("?limit=001"), 1)
  assert.equal(await count("?limit=%201%20"), 1, "trimmed")
  assert.equal(await count("?limit=1000"), 2, "clamped")
  assert.equal(await count("?limit="), 2, "empty is the default")
  assert.equal(await count("?limit=1&limit=abc"), 1, "the first value")
  for (const limit of ["abc", "1.5", "0", "-1", "-0", "1e2", "99999999999999999999", "%2B"]) {
    assertField(await send("GET", `${tasksPath}?limit=${limit}`), "limit", FALLBACK, limit)
  }
  for (const after of ["nope", "01JD8X3K7Q0000000000000000", "81jd8x3k7q0000000000000000", "01jd8x3k7q000000000000000i"]) {
    const res = await send("GET", `${tasksPath}?starting_after=${after}`)
    assertField(res, "starting_after", FALLBACK, after)
  }
  // The limit first.
  assertField(await send("GET", `${tasksPath}?limit=x&starting_after=x`), "limit", FALLBACK)
})

test("request_id is X-Request-ID as sent, or null", async (t) => {
  const { send } = await newApp(t)
  for (const [sent, want] of [
    [undefined, null],
    ["", null],
    [" ", " "],
    ["req-1", "req-1"]
  ] as const) {
    const res = await send(
      "GET",
      `${tasksPath}/01jd8x3k7q00000000000000zz`,
      undefined,
      sent === undefined ? {} : { headers: { "x-request-id": sent } }
    )
    assert.equal(res.json<{ error: { request_id: unknown } }>().error.request_id, want, String(sent))
  }
})

test("audit details: sorted keys, HTML and non-ASCII escaped", async (t) => {
  const { send } = await newApp(t)
  const res = await send("POST", tasksPath, JSON.stringify({ title: "<é😀&>" }))
  const task = res.json<Task>()
  assert.equal(
    res.headers[DETAILS_HEADER.toLowerCase()],
    `{"assignee_id":null,"status":"todo","task_id":"${task.id}","title":"\\u003c\\u00e9\\ud83d\\ude00\\u0026\\u003e"}`
  )
})

test("times are RFC 3339 UTC without trailing zeros, as Go's RFC3339Nano", async (t) => {
  const { create } = await newApp(t)
  const task = await create(environment, "Launch")
  assert.match(task.created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d*[1-9])?Z$/)
  assert.equal(task.created_at, task.updated_at)
})

test("the request log: the route's template or unknown, warn on a 4xx", async (t) => {
  const { send, accessLines } = await newApp(t)
  await send("GET", tasksPath)
  await send("GET", `${tasksPath}/01jd8x3k7q00000000000000zz`, undefined, {
    headers: { "x-request-id": "req-2" }
  })
  await send("GET", "/nope/01jd8x3k7q00000000000000zz")
  const [ok, missing, unknown] = accessLines()
  assert.equal(ok!.route, "/environments/:environment_id/tasks")
  assert.equal(ok!.level, "info")
  assert.equal("request_id" in ok!, false)
  assert.equal(ok!.node_id, environment)
  assert.equal(ok!.member_id, member)
  assert.equal(missing!.level, "warn")
  assert.equal(missing!.request_id, "req-2")
  assert.equal(unknown!.route, "unknown")
  assert.equal(unknown!.level, "warn")
})
