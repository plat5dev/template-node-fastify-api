import { context, propagation, trace } from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import { TracerProvider } from "@opentelemetry/sdk-trace"
import type { FastifyBaseLogger } from "fastify"
import assert from "node:assert/strict"
import { createServer, type IncomingHttpHeaders } from "node:http"
import type { AddressInfo } from "node:net"
import type { TestContext } from "node:test"
import { accessClient } from "./access.ts"
import { buildApp } from "./app.ts"
import { connect, migrate } from "./db.ts"
import { profilesStore } from "./profiles.ts"
import { tasksStore, type TasksStore } from "./tasks.ts"

// Register OTel context manager, W3C propagator, and a real local TracerProvider for tests.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
propagation.setGlobalPropagator(new W3CTraceContextPropagator())
trace.setGlobalTracerProvider(new TracerProvider())

export const MEMBER = "01jd8x3k7q00000000000000mm"

export type Method = "GET" | "POST" | "PATCH" | "DELETE" | "PUT" | "OPTIONS" | "HEAD"

/** Lightweight in-memory logger matching FastifyBaseLogger for unit tests outside Fastify. */
export const memoryLogger = (bindings: Record<string, unknown> = {}) => {
  const entries: Record<string, unknown>[] = []
  const make = (bound: Record<string, unknown>): FastifyBaseLogger => {
    const record =
      (level: string) =>
      (objOrMsg: unknown, msg?: string): void => {
        if (typeof objOrMsg === "string") {
          entries.push({ timestamp: new Date().toISOString(), level, ...bound, message: objOrMsg })
        } else {
          entries.push({
            timestamp: new Date().toISOString(),
            level,
            ...bound,
            ...(objOrMsg as Record<string, unknown>),
            ...(msg !== undefined ? { message: msg } : {})
          })
        }
      }
    const logger = {
      level: "info",
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
      debug: record("debug"),
      fatal: record("fatal"),
      trace: record("trace"),
      silent: () => {},
      child: (childBindings: Record<string, unknown>) => make({ ...bound, ...childBindings })
    }
    return logger as unknown as FastifyBaseLogger
  }
  return { log: make(bindings), entries }
}

/** Local HTTP server mocking identity's `/access/v1/evaluation` endpoint. */
export const serveIdentity = async (t: TestContext) => {
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
    res.writeHead(identity.status, { "content-type": "application/json" }).end(identity.body)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => server.close())
  identity.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return identity
}

export const newApp = async (
  t: TestContext,
  opts: { identityUnset?: boolean; permission?: string; tasks?: Partial<TasksStore> } = {}
) => {
  const rawLogs: string[] = []
  const identity = await serveIdentity(t)
  const db = connect(":memory:")
  migrate(db)
  t.after(() => db.close())

  const app = await buildApp({
    tasks: { ...tasksStore(db), ...opts.tasks },
    profiles: profilesStore(db),
    access: accessClient(opts.identityUnset ? undefined : identity.url),
    assigneePermission: opts.permission ?? "project:read",
    version: "test",
    logStream: {
      write(msg: string) {
        rawLogs.push(msg)
      }
    }
  })
  t.after(() => app.close())

  const send = (
    method: Method,
    url: string,
    body?: string,
    reqOpts: { without?: string; headers?: Record<string, string> } = {}
  ) => {
    const projectId = /^\/projects\/([^/?]+)/.exec(url)?.[1]
    const userId = /^\/users\/([^/?]+)/.exec(url)?.[1]
    const headers: Record<string, string> = {
      ...(projectId ? { "x-plat5-project-id": projectId, "x-plat5-member-id": MEMBER } : {}),
      ...(userId ? { "x-plat5-user-id": userId } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...reqOpts.headers
    }
    if (reqOpts.without) delete headers[reqOpts.without]
    return app.inject({ method, url, headers, ...(body === undefined ? {} : { payload: body }) })
  }

  const logged = (): Record<string, unknown>[] =>
    rawLogs.flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>]
      } catch {
        return []
      }
    })

  return { app, db, identity, send, logged }
}

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

export const assertValidationPaths = (res: Response, paths: string[], label = "") => {
  assert.equal(res.statusCode, 422, label)
  const error = errorOf(res)
  assert.equal(error.type, "invalid_request_error", label)
  assert.equal(error.code, "VALIDATION_ERROR", label)
  const fields = error.details.fields ?? []
  assert.deepEqual(
    fields.map((f) => f.path),
    paths,
    label
  )
  assert.equal(error.message, fields[0]?.message, label)
}

export const assertMalformed = (res: Response, label = "") => {
  assert.equal(res.statusCode, 400, label)
  const error = errorOf(res)
  assert.equal(error.type, "invalid_request_error", label)
  assert.equal(error.code, "INVALID_REQUEST", label)
  assert.equal(error.details, null, label)
}
