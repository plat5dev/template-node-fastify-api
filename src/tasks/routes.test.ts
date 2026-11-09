import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { CREATED_HEADER, DETAILS_HEADER } from "../audit.ts"
import type { Task } from "../schemas.ts"
import {
  assertField,
  assertFields,
  assertMalformed,
  errorOf,
  FALLBACK,
  MEMBER,
  type Method,
  newApp
} from "../testing.ts"
import { MEMBER_HEADER } from "./routes.ts"

const project = "01jd8x3k7q0000000000000000"
const other = "01jd8x3k7q0000000000000001"
const assignee = "01jd8x3k7q00000000000000aa"
const missingTask = "01jd8x3k7q00000000000000zz"
// Not the starter's, to show the check asks for the configured one.
const permission = "tasks:assignable"
const STATUS = "Status must be todo, in progress, or done."

const tasksPath = `/projects/${project}/tasks`
/** A write that sets the assignee. */
const assigning = JSON.stringify({ title: "Other", assignee_id: assignee })

/** What identity should be asked for an assignee on the project. */
const evaluation = (assigneeId: string) => ({
  subject: { type: "member", id: assigneeId },
  resource: { type: "project", id: project },
  action: { name: permission }
})

/** The task routes, with identity allowing every assignee until told otherwise. */
const setup = async (t: TestContext, opts: Parameters<typeof newApp>[1] = {}) => {
  const app = await newApp(t, { permission, ...opts })
  const { send } = app

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
  const accessLines = () => app.logged().filter((line) => line.message === "request completed")
  return { ...app, create, get, list, accessLines }
}

/** The POST and PATCH of a task, for a body both take. */
const writes = (task: Task) =>
  [
    ["POST", tasksPath],
    ["PATCH", `${tasksPath}/${task.id}`]
  ] as const

test("create", async (t) => {
  const { create } = await setup(t)
  const task = await create(project, "Launch")
  assert.equal(task.project_id, project)
  assert.equal(task.created_by, MEMBER)
  assert.equal(task.status, "todo")
  assert.equal(task.assignee_id, null)
  assert.match(task.id, /^[0-9a-z]{26}$/)
})

test("create needs the member, before the body", async (t) => {
  const { send } = await setup(t)
  for (const body of [`{"title":"Launch"}`, `{"title":""}`, `{`]) {
    assertMalformed(await send("POST", tasksPath, body, { without: MEMBER_HEADER }), body)
  }
})

test("scoped by project", async (t) => {
  const { send, create, list } = await setup(t)
  const task = await create(other, "Elsewhere")
  for (const method of ["GET", "PATCH", "DELETE"] as const) {
    const body = method === "PATCH" ? `{"title":"x"}` : undefined
    const res = await send(method, `${tasksPath}/${task.id}`, body)
    assert.equal(res.statusCode, 404, method)
    assert.deepEqual(errorOf(res).details, { resource: "task", id: task.id })
  }
  assert.deepEqual((await list()).tasks, [])
})

test("list pages", async (t) => {
  const { create, list } = await setup(t)
  const ids: string[] = []
  for (const title of ["a", "b", "c"]) ids.push((await create(project, title)).id)
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
})

test("tasks made in the same millisecond list in the order they were made", async (t) => {
  const { create, list } = await setup(t)
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-28T00:00:00.000Z") })
  const ids: string[] = []
  for (let i = 0; i < 10; i++) ids.push((await create(project, `t${i}`)).id)
  t.mock.timers.reset()
  assert.deepEqual(
    (await list()).tasks.map((task) => task.id),
    ids
  )
})

test("audit details", async (t) => {
  const { send } = await setup(t)
  const details = (res: { headers: Record<string, unknown> }) => {
    const header = res.headers[DETAILS_HEADER.toLowerCase()]
    return typeof header === "string" ? JSON.parse(header) : undefined
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
  res = await send("PATCH", path, `{"assignee_id":null}`)
  assert.deepEqual(details(res), { assignee_id: { from: assignee, to: null } })
  res = await send("PATCH", path, `{"status":"done"}`)
  assert.equal(details(res), undefined)

  res = await send("DELETE", path)
  assert.equal(res.statusCode, 204)
  assert.equal(details(res), undefined)
  assert.equal((await send("DELETE", path)).statusCode, 404)
})

test("audit details: sorted keys, HTML and non-ASCII escaped", async (t) => {
  const { send } = await setup(t)
  const res = await send("POST", tasksPath, JSON.stringify({ title: "<é😀&>" }))
  const task = res.json<Task>()
  assert.equal(
    res.headers[DETAILS_HEADER.toLowerCase()],
    `{"assignee_id":null,"status":"todo","task_id":"${task.id}","title":"\\u003c\\u00e9\\ud83d\\ude00\\u0026\\u003e"}`
  )
})

test("create with an assignee", async (t) => {
  const { identity, send, get } = await setup(t)
  const res = await send(
    "POST",
    tasksPath,
    JSON.stringify({ title: "Launch", assignee_id: assignee })
  )
  assert.equal(res.statusCode, 201)
  const task = res.json<Task>()
  assert.equal(task.assignee_id, assignee)
  assert.equal((await get(task.id)).assignee_id, assignee)
  // The assignee, on the project from the path, for the configured permission.
  assert.deepEqual(identity.asked, [evaluation(assignee)])
})

test("the evaluation carries the request's X-Request-ID and traceparent", async (t) => {
  const { identity, send } = await setup(t)
  const traceId = "0af7651916cd43dd8448eb211c80319c"
  const res = await send("POST", tasksPath, assigning, {
    headers: { "x-request-id": "req-1", traceparent: `00-${traceId}-b7ad6b7169203331-01` }
  })
  assert.equal(res.statusCode, 201)
  assert.equal(identity.headers[0]?.["x-request-id"], "req-1")
  assert.match(
    String(identity.headers[0]?.traceparent),
    new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`)
  )
})

test("a refused assignee is a 422, and nothing is written", async (t) => {
  const { identity, send, create, list } = await setup(t)
  const task = await create(project, "Launch")
  identity.body = `{"decision":false}`
  for (const [method, path] of writes(task)) {
    assertField(
      await send(method, path, assigning),
      "assignee_id",
      "That person can't see this project.",
      method
    )
  }
  assert.deepEqual(
    (await list()).tasks.map((t) => [t.title, t.assignee_id]),
    [["Launch", null]]
  )
  assert.deepEqual(identity.asked, [evaluation(assignee), evaluation(assignee)])
})

for (const [name, status, answer, identityUnset] of [
  ["identity answers 503", 503, `{"error":{"code":"SERVICE_UNAVAILABLE"}}`, false],
  ["identity answers 500", 500, `{"error":{}}`, false],
  ["identity answers without a decision", 200, `{}`, false],
  ["IDENTITY_INTERNAL_URL unset", 200, `{"decision":true}`, true]
] as const) {
  test(`no answer is a 503, and nothing is written: ${name}`, async (t) => {
    const { identity, send, create, list, logged } = await setup(t, { identityUnset })
    const task = await create(project, "Launch")
    identity.status = status
    identity.body = answer
    for (const [method, path] of writes(task)) {
      const res = await send(method, path, assigning, {
        headers: { "x-request-id": `req-${method}` }
      })
      assert.equal(res.statusCode, 503)
      const error = errorOf(res)
      assert.equal(error.code, "SERVICE_UNAVAILABLE")
      assert.equal(error.request_id, `req-${method}`)
    }
    assert.deepEqual(
      (await list()).tasks.map((t) => [t.title, t.assignee_id]),
      [["Launch", null]]
    )
    // Logged with the request id.
    const failures = logged().filter((line) => line.message === "access evaluation failed")
    assert.deepEqual(
      failures.map((line) => line.request_id),
      ["req-POST", "req-PATCH"]
    )
  })
}

test("update an assignee", async (t) => {
  const { identity, send, create, get } = await setup(t)
  const task = await create(project, "Launch")
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
  assert.equal(res.json<Task>().assignee_id, assignee)
  res = await send("PATCH", path, `{"assignee_id":null}`)
  assert.equal(res.json<Task>().assignee_id, null)
  assert.equal((await get(task.id)).assignee_id, null)
  assert.equal(identity.asked.length, 2)
})

test("no assignee, no check", async (t) => {
  const { identity, send, list } = await setup(t)
  for (const body of [`{"title":"a"}`, `{"title":"b","assignee_id":null}`]) {
    const res = await send("POST", tasksPath, body)
    assert.equal(res.statusCode, 201)
    assert.equal(res.json<Task>().assignee_id, null)
  }
  const task = (await list()).tasks[0]!
  for (const body of [`{"status":"done"}`, `{"assignee_id":null}`]) {
    assert.equal((await send("PATCH", `${tasksPath}/${task.id}`, body)).statusCode, 200)
  }
  assert.deepEqual(identity.asked, [])
})

test("a bad assignee id is a 422 at assignee_id", async (t) => {
  const { identity, send, create } = await setup(t)
  const task = await create(project, "Launch")
  for (const value of [`""`, `"someone"`, `"01JD8X3K7Q00000000000000AA"`, `5`, `{}`, `[]`]) {
    for (const [method, path] of writes(task)) {
      assertField(
        await send(method, path, `{"title":"Other","assignee_id":${value}}`),
        "assignee_id",
        FALLBACK
      )
    }
  }
  assert.deepEqual(identity.asked, [])
})

test("update order: the body, then the task, then identity", async (t) => {
  const { identity, send } = await setup(t)
  const missing = `${tasksPath}/${missingTask}`
  let res = await send("PATCH", missing, JSON.stringify({ title: "", assignee_id: assignee }))
  assert.equal(res.statusCode, 422)
  res = await send("PATCH", missing, JSON.stringify({ assignee_id: assignee }))
  assert.equal(res.statusCode, 404)
  assert.deepEqual(identity.asked, [])
})

test("title and status errors, word for word", async (t) => {
  const { send, create } = await setup(t)
  const task = await create(project, "Launch")
  for (const [method, path] of writes(task)) {
    for (const title of ["", "   ", "\t　\n"]) {
      assertField(
        await send(method, path, JSON.stringify({ title })),
        "title",
        "Title is required.",
        method
      )
    }
    assertField(
      await send(method, path, JSON.stringify({ title: "x".repeat(256) })),
      "title",
      "Title is too long."
    )
    for (const status of ["TODO", "in progress", " done", "", 5, true]) {
      const res = await send(method, path, JSON.stringify({ title: "Launch", status }))
      assertField(res, "status", STATUS, `${method} ${status}`)
    }
  }
  // A create without a title; a null one is the wrong type, and so is a null status.
  assertField(await send("POST", tasksPath, `{}`), "title", "Title is required.")
  assertField(await send("POST", tasksPath, `{"title":null}`), "title", FALLBACK)
  assertField(await send("POST", tasksPath, `{"title":"Launch","status":null}`), "status", STATUS)
})

test("titles are trimmed of white space", async (t) => {
  const { send, create } = await setup(t)
  let res = await send("POST", tasksPath, JSON.stringify({ title: " \t Launch　 " }))
  assert.equal(res.statusCode, 201)
  assert.equal(res.json<Task>().title, "Launch")
  const task = await create(project, "Launch")
  res = await send("PATCH", `${tasksPath}/${task.id}`, JSON.stringify({ title: "  Renamed  " }))
  assert.equal(res.json<Task>().title, "Renamed")
  // The limit is the trimmed title's.
  res = await send("POST", tasksPath, JSON.stringify({ title: ` ${"x".repeat(255)} ` }))
  assert.equal(res.statusCode, 201)
})

test("a title's limit counts characters, not UTF-16 units", async (t) => {
  const { send, get } = await setup(t)
  for (const [title, ok] of [
    ["é".repeat(255), true],
    ["😀".repeat(255), true],
    ["é".repeat(256), false],
    ["😀".repeat(256), false]
  ] as const) {
    const res = await send("POST", tasksPath, JSON.stringify({ title }))
    if (!ok) {
      assertField(res, "title", "Title is too long.")
      continue
    }
    assert.equal(res.statusCode, 201)
    assert.equal((await get(res.json<Task>().id)).title, title)
  }
})

test("PATCH: null leaves a field as it is, and a no-op still answers the task", async (t) => {
  const { send, create } = await setup(t)
  const task = await create(project, "Launch")
  for (const body of [`{"title":null,"status":null}`, `{}`]) {
    const res = await send("PATCH", `${tasksPath}/${task.id}`, body)
    assert.equal(res.statusCode, 200)
    const updated = res.json<Task>()
    assert.deepEqual([updated.title, updated.status], ["Launch", "todo"])
    assert.equal(res.headers[DETAILS_HEADER.toLowerCase()], undefined)
  }
})

test("DELETE never reads its body", async (t) => {
  const { send, create } = await setup(t)
  for (const [contentType, body] of [
    ["application/json", ""],
    ["application/json", "{"],
    ["text/plain", "hello"],
    [undefined, "x"]
  ] as const) {
    const task = await create(project, "Launch")
    const headers: Record<string, string> =
      contentType === undefined ? {} : { "content-type": contentType }
    const res = await send("DELETE", `${tasksPath}/${task.id}`, body, {
      headers,
      without: contentType ? undefined : "content-type"
    })
    assert.equal(res.statusCode, 204, `${contentType} ${body}`)
  }
})

test("a known path in another method, or OPTIONS, is the unknown route's 404", async (t) => {
  const { send, create } = await setup(t)
  const task = await create(project, "Launch")
  const taskPath = `${tasksPath}/${task.id}`
  for (const [method, path] of [
    ["PUT", taskPath],
    ["POST", taskPath],
    ["DELETE", tasksPath],
    ["PATCH", tasksPath],
    ["PATCH", "/users/01jd8x3k7q00000000000000u1/profile"],
    ["OPTIONS", tasksPath],
    ["OPTIONS", taskPath],
    ["GET", "/nope"],
    ["GET", "/users/01jd8x3k7q00000000000000u1"]
  ] as const) {
    const body = method === "OPTIONS" || method === "GET" ? undefined : "{}"
    const res = await send(method, path, body, { headers: { "x-request-id": "req-9" } })
    assert.equal(res.statusCode, 404, `${method} ${path}`)
    assert.equal(res.headers.allow, undefined)
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

test("a URL Fastify can't decode is a 400 in the envelope", async (t) => {
  const { send } = await setup(t)
  assertMalformed(await send("GET", `${tasksPath}/%E0%A4%A`))
})

test("an unexpected error is the fallback 500, never its own text", async (t) => {
  const { send } = await setup(t, {
    tasks: {
      list: () => {
        throw new Error("SQLITE_BUSY: database is locked at /data/app.db")
      }
    }
  })
  const res = await send("GET", tasksPath, undefined, { headers: { "x-request-id": "req-5" } })
  assert.equal(res.statusCode, 500)
  assert.deepEqual(res.json(), {
    error: {
      type: "api_error",
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred.",
      request_id: "req-5",
      details: null
    }
  })
})

test("a body not sent as application/json is a 400, and nothing is written", async (t) => {
  const { send, create, list } = await setup(t)
  const task = await create(project, "Launch")
  for (const [contentType, body] of [
    [undefined, `{"title":"Other"}`],
    [undefined, ""],
    ["text/plain", `{"title":"Other"}`],
    ["text/plain", ""],
    ["application/x-www-form-urlencoded", "title=Other"],
    ["application/jsonx", `{"title":"Other"}`],
    ["application/merge-patch+json", `{"title":"Other"}`],
    ["", `{"title":"Other"}`],
    ["not a type", `{"title":"Other"}`]
  ] as const) {
    for (const [method, path] of writes(task)) {
      const opts =
        contentType === undefined
          ? { without: "content-type" }
          : { headers: { "content-type": contentType } }
      assertMalformed(await send(method, path, body, opts), `${method} ${contentType}`)
    }
  }
  // And no body at all.
  for (const [method, path] of writes(task)) assertMalformed(await send(method, path))
  assert.deepEqual(
    (await list()).tasks.map((t) => t.title),
    ["Launch"]
  )
})

test("JSON is application/json, with any parameters", async (t) => {
  const { send } = await setup(t)
  for (const contentType of [
    "application/json",
    "Application/JSON",
    "application/json;charset=UTF-8;",
    'application/json; charset="utf-8"'
  ]) {
    const res = await send("POST", tasksPath, `{"title":"Launch"}`, {
      headers: { "content-type": contentType }
    })
    assert.equal(res.statusCode, 201, contentType)
  }
})

test("an empty body or one that isn't JSON is a 400; JSON that isn't an object is a 422 at body", async (t) => {
  const { send, create } = await setup(t)
  const task = await create(project, "Launch")
  for (const [method, path] of writes(task)) {
    for (const body of ["", " ", "{", `{"title":"a"} x`]) {
      assertMalformed(await send(method, path, body), `${method} ${body}`)
    }
    for (const body of [`[{"title":"a"}]`, `"a"`, "5", "true", "null"]) {
      assertField(await send(method, path, body), "body", FALLBACK, `${method} ${body}`)
    }
  }
})

test("a field of the wrong JSON type is a 422 at that field, never coerced", async (t) => {
  const { send, create } = await setup(t)
  const task = await create(project, "Launch")
  for (const [body, fields] of [
    [`{"title":123}`, [{ path: "title", message: FALLBACK }]],
    [`{"title":true}`, [{ path: "title", message: FALLBACK }]],
    [`{"title":["a"]}`, [{ path: "title", message: FALLBACK }]],
    [`{"title":"Launch","status":5}`, [{ path: "status", message: STATUS }]],
    // Every wrong field, in the body's order.
    [
      `{"title":"","status":5}`,
      [
        { path: "title", message: "Title is required." },
        { path: "status", message: STATUS }
      ]
    ],
    [
      `{"assignee_id":5,"status":"x","title":7}`,
      [
        { path: "assignee_id", message: FALLBACK },
        { path: "status", message: STATUS },
        { path: "title", message: FALLBACK }
      ]
    ]
  ] as const) {
    for (const [method, path] of writes(task))
      assertFields(await send(method, path, body), [...fields], `${method} ${body}`)
  }
})

test("keys match exactly: an unknown field is a 422 naming each, before anything else", async (t) => {
  const { send, create, get, list, identity } = await setup(t)
  const task = await create(project, "Launch")
  for (const [method, url, body, paths] of [
    ["POST", tasksPath, `{"Title":"x"}`, ["Title"]],
    ["POST", tasksPath, `{"title":"x","priority":1}`, ["priority"]],
    [
      "POST",
      tasksPath,
      `{"Status":"done","title":"","Assignee_ID":"${assignee}"}`,
      ["Status", "Assignee_ID"]
    ],
    ["POST", tasksPath, `{"x":1,"title":"x","y":2,"x":3}`, ["x", "y"]],
    // As JSON.parse orders an object's keys: integer-like ones first.
    ["POST", tasksPath, `{"b":1,"title":"x","1":2}`, ["1", "b"]],
    ["PATCH", `${tasksPath}/${task.id}`, `{"Title":"x"}`, ["Title"]],
    // A missing task: the body first.
    ["PATCH", `${tasksPath}/${missingTask}`, `{"title":"x","extra":{"a":1}}`, ["extra"]]
  ] as const) {
    const fields = paths.map((path) => ({ path, message: `${path} isn't a field.` }))
    assertFields(await send(method as Method, url, body), fields, `${method} ${body}`)
  }
  assert.equal((await list()).tasks.length, 1)
  const got = await get(task.id)
  assert.equal(got.title, "Launch")
  assert.equal(got.updated_at, task.updated_at, "a refused PATCH wrote")
  assert.deepEqual(identity.asked, [])
})

test("list parameters, as plat5 docs/reference/lists.md has them", async (t) => {
  const { send, create } = await setup(t)
  for (const title of ["a", "b"]) await create(project, title)
  const count = async (query: string) => {
    const res = await send("GET", `${tasksPath}${query}`)
    assert.equal(res.statusCode, 200, query)
    return res.json<{ tasks: Task[] }>().tasks.length
  }
  assert.equal(await count(""), 2)
  assert.equal(await count("?limit=1"), 1)
  assert.equal(await count("?limit=001"), 1)
  assert.equal(await count("?limit=1000"), 2) // clamped
  for (const limit of ["", "abc", "1.5", "0", "-1", "+1", " 1", "1e1", "0x10"]) {
    assertField(
      await send("GET", `${tasksPath}?limit=${encodeURIComponent(limit)}`),
      "limit",
      FALLBACK,
      limit
    )
  }
  assertField(await send("GET", `${tasksPath}?limit=1&limit=2`), "limit", FALLBACK)
  for (const after of [
    "",
    "nope",
    "01JD8X3K7Q0000000000000000",
    "81jd8x3k7q0000000000000000",
    "01jd8x3k7q000000000000000i"
  ]) {
    assertField(
      await send("GET", `${tasksPath}?starting_after=${after}`),
      "starting_after",
      FALLBACK,
      after
    )
  }
  // Both wrong: both named, the limit first.
  assertFields(await send("GET", `${tasksPath}?starting_after=x&limit=x`), [
    { path: "limit", message: FALLBACK },
    { path: "starting_after", message: FALLBACK }
  ])
})

test("request_id is X-Request-ID as sent, or null", async (t) => {
  const { send } = await setup(t)
  for (const [sent, want] of [
    [undefined, null],
    ["", null],
    ["req-1", "req-1"]
  ] as const) {
    const headers: Record<string, string> = sent === undefined ? {} : { "x-request-id": sent }
    const res = await send("GET", `${tasksPath}/${missingTask}`, undefined, { headers })
    assert.deepEqual(Object.keys(res.json<{ error: object }>().error), [
      "type",
      "code",
      "message",
      "request_id",
      "details"
    ])
    assert.equal(errorOf(res).request_id, want)
  }
})

test("times are RFC 3339 in UTC, to the millisecond", async (t) => {
  const { create } = await setup(t)
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-28T00:00:00.000Z") })
  const task = await create(project, "Launch")
  t.mock.timers.reset()
  assert.equal(task.created_at, "2026-10-28T00:00:00.000Z")
  assert.equal(task.updated_at, task.created_at)
})

test("request logs carry the ids the front door gave", async (t) => {
  const { send, accessLines } = await setup(t)
  const user = "01jd8x3k7q00000000000000u1"
  await send("GET", tasksPath)
  await send("GET", `/users/${user}/profile`)
  assert.deepEqual(
    accessLines().map((line) => [line.node_id, line.member_id, line.user_id]),
    [
      [project, MEMBER, undefined],
      [undefined, undefined, user]
    ]
  )
})

test("the request log: the route's template or unknown, warn on a 4xx", async (t) => {
  const { send, accessLines } = await setup(t)
  const user = "01jd8x3k7q00000000000000u1"
  await send("GET", tasksPath)
  await send("GET", `${tasksPath}/${missingTask}`, undefined, {
    headers: { "x-request-id": "req-2" }
  })
  await send("GET", `/nope/${missingTask}`)
  await send("PATCH", `/users/${user}/profile`, "{}")
  const [ok, missing, unknown, wrongMethod] = accessLines()
  assert.equal(ok?.route, "/projects/:project_id/tasks")
  assert.equal(ok?.level, "info")
  assert.equal("request_id" in ok!, false)
  assert.equal(typeof ok?.duration_ms, "number")
  assert.equal(missing?.route, "/projects/:project_id/tasks/:task_id")
  assert.equal(missing?.level, "warn")
  assert.equal(missing?.request_id, "req-2")
  assert.deepEqual([unknown?.route, unknown?.level], ["unknown", "warn"])
  // No route, but the id the gateway sent.
  assert.deepEqual([wrongMethod?.route, wrongMethod?.user_id], ["unknown", user])
})

test("the OpenAPI document, at /openapi.json, has the assignee and the answers", async (t) => {
  const { send } = await setup(t)
  const res = await send("GET", "/openapi.json")
  assert.equal(res.statusCode, 200)
  type Op = {
    requestBody?: {
      content: Record<
        string,
        { schema: { properties: Record<string, { type?: string; nullable?: boolean }> } }
      >
    }
    responses: Record<string, unknown>
  }
  const spec = res.json<{ info: { version: string }; paths: Record<string, Record<string, Op>> }>()
  assert.equal(spec.info.version, "test")
  const tasks = spec.paths["/projects/{project_id}/tasks"]!
  const one = spec.paths["/projects/{project_id}/tasks/{task_id}"]!
  for (const op of [tasks.post!, one.patch!]) {
    const body = op.requestBody?.content["application/json"]?.schema
    // A string or null, as OpenAPI 3.0 writes it.
    assert.deepEqual(
      [body?.properties.assignee_id?.type, body?.properties.assignee_id?.nullable],
      ["string", true]
    )
  }
  assert.deepEqual(Object.keys(tasks.post!.responses), ["201", "400", "422", "503"])
  assert.deepEqual(Object.keys(one.patch!.responses), ["200", "400", "404", "422", "503"])
  assert.equal((await send("GET", "/docs")).statusCode < 400, true)
})
