import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor
} from "@opentelemetry/sdk-trace-base"
import Fastify from "fastify"
import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { notFound, serviceUnavailable } from "../errors.js"
import type { App } from "../types.js"
import { registerObservability } from "./observability.js"
import { redactQuery } from "./redact.js"

const exporter = new InMemorySpanExporter()
trace.setGlobalTracerProvider(
  new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
)

/** An API whose routes succeed and fail, behind the middleware, its spans and log lines recorded. */
const serve = async (t: TestContext) => {
  exporter.reset()
  const app = Fastify({ logger: false, trustProxy: true }) as unknown as App
  registerObservability(app)
  app.get("/ok", async () => ({}))
  app.get("/missing", async () => {
    throw notFound("node", "n1")
  })
  app.get("/die", async () => {
    throw new Error("SQLITE_BUSY: database is locked at /data/app.db")
  })
  app.get("/unavailable", async () => {
    throw serviceUnavailable()
  })
  await app.ready()
  const logs = t.mock.method(console, "log", () => undefined)
  t.after(() => app.close())
  const lines = () =>
    logs.mock.calls
      .map((call) => JSON.parse(String(call.arguments[0])) as Record<string, unknown>)
      .filter((line) => line.message === "request completed")
  const spans = () => exporter.getFinishedSpans().filter((span) => span.kind === SpanKind.SERVER)
  return { app, lines, spans }
}

test("redactQuery: the listed keys' values are REDACTED, exactly as named", () => {
  const cases: Record<string, string> = {
    "a=1&b=2": "a=1&b=2",
    "sig=abc&a=1": "sig=REDACTED&a=1",
    "X-Amz-Signature=x&X-Amz-Credential=y&X-Amz-Security-Token=z":
      "X-Amz-Signature=REDACTED&X-Amz-Credential=REDACTED&X-Amz-Security-Token=REDACTED",
    "Signature=s&AWSAccessKeyId=k&X-Goog-Signature=g":
      "Signature=REDACTED&AWSAccessKeyId=REDACTED&X-Goog-Signature=REDACTED",
    "SIG=abc&sig": "SIG=abc&sig",
    "q=a%20b+c&sig=": "q=a%20b+c&sig=REDACTED"
  }
  for (const [query, want] of Object.entries(cases)) assert.equal(redactQuery(query), want, query)
})

test("the HTTP server span has url.scheme and the redacted url.query", async (t) => {
  const { app, spans } = await serve(t)
  await app.inject({ url: "/ok?sig=secret&page=2&X-Amz-Signature=s3" })
  const [span] = spans()
  assert.equal(span?.attributes["url.scheme"], "http")
  assert.equal(span?.attributes["url.path"], "/ok")
  assert.equal(span?.attributes["url.query"], "sig=REDACTED&page=2&X-Amz-Signature=REDACTED")
  assert.equal(span?.attributes["url.full"], undefined)
})

test("url.scheme is the request's, not X-Forwarded-Proto's", async (t) => {
  const { app, spans } = await serve(t)
  await app.inject({ url: "/ok", headers: { "x-forwarded-proto": "https" } })
  assert.equal(spans()[0]?.attributes["url.scheme"], "http")
})

test("a 2xx span's status is unset", async (t) => {
  const { app, spans } = await serve(t)
  await app.inject({ url: "/ok" })
  assert.deepEqual(spans()[0]?.status, { code: SpanStatusCode.UNSET })
})

test("a request without a query has no url.query", async (t) => {
  const { app, spans } = await serve(t)
  await app.inject({ url: "/ok" })
  await app.inject({ url: "/ok?" })
  assert.equal(spans().length, 2)
  for (const span of spans()) assert.equal("url.query" in span.attributes, false)
})

test("error.type and error_type on a 5xx only", async (t) => {
  const { app, lines, spans } = await serve(t)
  assert.equal((await app.inject({ url: "/die" })).statusCode, 500)
  assert.equal((await app.inject({ url: "/missing" })).statusCode, 404)
  const [broken, missing] = spans()
  const [brokenLine, missingLine] = lines()

  assert.equal(broken?.attributes["error.type"], "internal")
  assert.equal("error.kind" in (broken?.attributes ?? {}), false)
  assert.deepEqual(broken?.status, { code: SpanStatusCode.ERROR }) // no description
  assert.equal(brokenLine?.level, "error")
  assert.equal(brokenLine?.error_type, "internal")
  assert.equal(brokenLine?.error_message, "INTERNAL_ERROR: An unexpected error occurred.")
  assert.equal(brokenLine && "error_kind" in brokenLine, false)

  assert.equal("error.type" in (missing?.attributes ?? {}), false)
  assert.deepEqual(missing?.status, { code: SpanStatusCode.UNSET })
  assert.equal(missingLine && "error_type" in missingLine, false)
})

test("a 503 is the network's", async (t) => {
  const { app, lines, spans } = await serve(t)
  assert.equal((await app.inject({ url: "/unavailable" })).statusCode, 503)
  assert.equal(spans()[0]?.attributes["error.type"], "network")
  assert.equal(lines()[0]?.error_type, "network")
})
