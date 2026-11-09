import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace"
import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { redactQuery } from "./redact.ts"
import { newApp } from "./testing.ts"

const exporter = new InMemorySpanExporter()
trace.setGlobalTracerProvider(
  new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] })
)

const project = "01jd8x3k7q0000000000000000"
const tasksPath = `/projects/${project}/tasks`

/** The API, its task list failing with an unexpected error when `broken`; its spans and log lines recorded. */
const serve = async (t: TestContext, opts: { broken?: boolean } = {}) => {
  exporter.reset()
  const app = await newApp(t, {
    identityUnset: true,
    ...(opts.broken
      ? {
          tasks: {
            list: () => {
              throw new Error("SQLITE_BUSY: database is locked")
            }
          }
        }
      : {})
  })
  const lines = () => app.logged().filter((line) => line.message === "request completed")
  const spans = () => exporter.getFinishedSpans().filter((span) => span.kind === SpanKind.SERVER)
  return { ...app, lines, spans }
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

test("the HTTP server span: named for the route, its attributes, the front door's ids, the trace's parent", async (t) => {
  const { send, spans } = await serve(t)
  const traceId = "0af7651916cd43dd8448eb211c80319c"
  await send("GET", `${tasksPath}?sig=secret&limit=2&X-Amz-Signature=s3`, undefined, {
    headers: {
      "x-request-id": "req-1",
      traceparent: `00-${traceId}-b7ad6b7169203331-01`,
      "x-forwarded-proto": "https"
    }
  })
  const [span] = spans()
  assert.equal(span?.name, "GET /projects/:project_id/tasks")
  assert.equal(span?.spanContext().traceId, traceId)
  assert.equal(span?.parentSpanContext?.spanId, "b7ad6b7169203331")
  assert.deepEqual(span?.attributes, {
    "http.request.method": "GET",
    "url.path": tasksPath,
    // The connection's, not X-Forwarded-Proto's.
    "url.scheme": "http",
    "url.query": "sig=REDACTED&limit=2&X-Amz-Signature=REDACTED",
    "http.route": "/projects/:project_id/tasks",
    request_id: "req-1",
    "http.response.status_code": 200,
    "plat5.node_id": project,
    "plat5.member_id": "01jd8x3k7q00000000000000mm"
  })
  assert.deepEqual(span?.status, { code: SpanStatusCode.UNSET })
})

test("an unmatched request's span is named for its method; no query, no url.query", async (t) => {
  const { send, spans } = await serve(t)
  await send("GET", "/nope")
  await send("GET", "/nope?")
  for (const span of spans()) {
    assert.equal(span.name, "GET")
    assert.equal("http.route" in span.attributes, false)
    assert.equal("url.query" in span.attributes, false)
  }
})

test("error.type and error_type on a 5xx only; a 4xx isn't a failed span", async (t) => {
  const { send, lines, spans } = await serve(t, { broken: true })
  assert.equal((await send("GET", tasksPath)).statusCode, 500)
  assert.equal((await send("GET", `${tasksPath}/01jd8x3k7q00000000000000zz`)).statusCode, 404)
  const [broken, missing] = spans()
  const [brokenLine, missingLine] = lines()

  assert.equal(broken?.attributes["error.type"], "internal")
  assert.equal(broken?.status.code, SpanStatusCode.ERROR)
  assert.equal(broken?.events[0]?.name, "exception")
  assert.equal(brokenLine?.level, "error")
  assert.equal(brokenLine?.error_type, "internal")
  // The cause, in the log only.
  assert.equal(brokenLine?.error_message, "SQLITE_BUSY: database is locked")
  assert.equal(brokenLine?.trace_id, broken?.spanContext().traceId)
  assert.equal(brokenLine?.span_id, broken?.spanContext().spanId)

  assert.equal("error.type" in (missing?.attributes ?? {}), false)
  assert.deepEqual(missing?.status, { code: SpanStatusCode.UNSET })
  assert.equal(missingLine?.level, "warn")
  assert.equal(missingLine && "error_type" in missingLine, false)
})

test("a 503 is the network's", async (t) => {
  const { send, lines, spans } = await serve(t)
  const res = await send(
    "POST",
    tasksPath,
    JSON.stringify({ title: "x", assignee_id: "01jd8x3k7q00000000000000aa" })
  )
  assert.equal(res.statusCode, 503)
  assert.equal(spans()[0]?.attributes["error.type"], "network")
  assert.equal(lines()[0]?.error_type, "network")
  assert.equal(lines()[0]?.error_message, "SERVICE_UNAVAILABLE: Service temporarily unavailable.")
})
