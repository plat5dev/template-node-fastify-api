/** For tests: the public API on an in-memory database, with identity faked by a local HTTP server. */
import { propagation } from "@opentelemetry/api"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import assert from "node:assert/strict"
import { createServer, type IncomingHttpHeaders } from "node:http"
import type { AddressInfo } from "node:net"
import type { TestContext } from "node:test"
import { accessClient } from "./access.ts"
import { buildApp } from "./app.ts"
import { connect, migrate } from "./db.ts"
import { profilesStore } from "./profiles/store.ts"
import { tasksStore, type TasksStore } from "./tasks/store.ts"

// initTelemetry's propagator.
propagation.setGlobalPropagator(new W3CTraceContextPropagator())

export const FALLBACK = "That doesn't look right."

/**
 * Identity's access evaluation, answering each with `status` and `body` (a decision of true
 * until told otherwise), and keeping each body and its headers.
 */
export const serveIdentity = async (t: TestContext) => {
  const identity = {
    url: "",
    status: 200,
    body: `{"decision":true}`,
    asked: [] as unknown[],
    headers: [] as IncomingHttpHeaders[]
  }
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/access/v1/evaluation")
      return res.writeHead(404).end()
    let sent = ""
    for await (const chunk of req) sent += chunk
    identity.asked.push(JSON.parse(sent))
    identity.headers.push(req.headers)
    res.writeHead(identity.status, { "content-type": "application/json" }).end(identity.body)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => server.close())
  identity.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return identity
}

export type Method = "GET" | "POST" | "PATCH" | "DELETE" | "PUT" | "OPTIONS" | "HEAD"

/**
 * The API, its request logs kept out of the test output. `identityUnset` leaves identity's
 * URL unset; `tasks` overrides the task store's methods (one that throws, say).
 */
export const newApp = async (
  t: TestContext,
  opts: { identityUnset?: boolean; permission?: string; tasks?: Partial<TasksStore> } = {}
) => {
  const logs = t.mock.method(console, "log", () => {})
  const identity = await serveIdentity(t)
  const db = connect(":memory:")
  migrate(db)
  t.after(() => db.close())
  const app = await buildApp({
    tasks: { ...tasksStore(db), ...opts.tasks },
    profiles: profilesStore(db),
    access: accessClient(opts.identityUnset ? undefined : identity.url),
    assigneePermission: opts.permission ?? "project:read",
    version: "test"
  })
  t.after(() => app.close())

  /**
   * Sends what the gateway sends: on a project route the project's id and the caller's member
   * id, on a user route the user's id, and JSON's content type with a body; but for the
   * header in `without`.
   */
  const send = (
    method: Method,
    url: string,
    body?: string,
    opts: { without?: string; headers?: Record<string, string> } = {}
  ) => {
    const projectId = /^\/projects\/([^/?]+)/.exec(url)?.[1]
    const userId = /^\/users\/([^/?]+)/.exec(url)?.[1]
    const headers: Record<string, string> = {
      ...(projectId ? { "x-plat5-project-id": projectId, "x-plat5-member-id": MEMBER } : {}),
      ...(userId ? { "x-plat5-user-id": userId } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...opts.headers
    }
    if (opts.without) delete headers[opts.without]
    return app.inject({ method, url, headers, ...(body === undefined ? {} : { payload: body }) })
  }

  /** The JSON lines logged so far. */
  const logged = (): Record<string, unknown>[] =>
    logs.mock.calls.flatMap((call) => {
      try {
        return [JSON.parse(String(call.arguments[0]))]
      } catch {
        return []
      }
    })

  return { app, db, identity, send, logged }
}

/** The member the fake gateway sends on a project route. */
export const MEMBER = "01jd8x3k7q00000000000000mm"

type Response = { statusCode: number; json: <T>() => T }

export type ErrorBody = {
  error: {
    type: string
    code: string
    message: string
    request_id: string | null
    details: { fields?: { path: string; message: string }[] } & Record<string, unknown>
  }
}

export const errorOf = (res: Response) => res.json<ErrorBody>().error

/** Asserts the 422 for `fields`, the first one's sentence its message. */
export const assertFields = (
  res: Response,
  fields: { path: string; message: string }[],
  label = ""
) => {
  assert.equal(res.statusCode, 422, label)
  const error = errorOf(res)
  assert.equal(error.code, "VALIDATION_ERROR", label)
  assert.equal(error.message, fields[0]?.message, label)
  assert.deepEqual(error.details.fields, fields, label)
}

/** Asserts the 422 for one field. */
export const assertField = (res: Response, path: string, message: string, label = "") =>
  assertFields(res, [{ path, message }], label)

/** Asserts the 400 for a request malformed before its values are read. */
export const assertMalformed = (res: Response, label = "") => {
  assert.equal(res.statusCode, 400, label)
  const error = errorOf(res)
  assert.equal(error.code, "INVALID_REQUEST", label)
  assert.equal(error.message, "Malformed request.", label)
  assert.equal(error.details, null, label)
}
