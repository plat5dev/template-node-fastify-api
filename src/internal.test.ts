import { diag, DiagLogLevel } from "@opentelemetry/api"
import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import { after, test, type TestContext } from "node:test"
import { connect, migrate } from "./db.ts"
import { createInternalServer } from "./internal.ts"
import { createDiagLogger, initTelemetry } from "./telemetry.ts"
import { memoryLogger } from "./testing.ts"

const telemetry = initTelemetry({ otlpEndpoint: undefined, version: "test" })
after(() => telemetry.shutdown())

const serve = async (t: TestContext) => {
  const db = connect(":memory:")
  migrate(db)
  const server = createInternalServer(db, telemetry.metrics)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => server.close())
  return { db, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

test("health: live and ready reflect database availability", async (t) => {
  const { db, url } = await serve(t)
  let res = await fetch(`${url}/health/live`)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { status: "healthy" })

  res = await fetch(`${url}/health/ready`)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { status: "healthy" })

  db.close()
  res = await fetch(`${url}/health/ready`)
  assert.equal(res.status, 503)
  assert.deepEqual(await res.json(), { status: "unhealthy" })
})

test("/metrics exposes HTTP and process series without scope or target_info", async (t) => {
  const { url } = await serve(t)
  telemetry.observeRequest("GET", "/projects/:project_id/tasks", 200, 0.003)

  const res = await fetch(`${url}/metrics`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get("content-type") ?? "", /^text\/plain/)
  const text = await res.text()

  for (const series of [
    `http_requests_total{method="GET",route="/projects/:project_id/tasks",status="200"} 1`,
    `http_request_duration_seconds_bucket{method="GET",route="/projects/:project_id/tasks",le="0.005"} 1`,
    `http_request_duration_seconds_bucket{method="GET",route="/projects/:project_id/tasks",le="5"} 1`
  ]) {
    assert.ok(text.includes(series), series)
  }
  for (const name of [
    "process_resident_memory_bytes",
    "process_cpu_seconds_total",
    "process_start_time_seconds"
  ]) {
    assert.match(text, new RegExp(`^${name} \\d`, "m"), name)
  }
  assert.equal(text.includes("otel_scope"), false)
  assert.equal(text.includes("target_info"), false)
})

test("unknown internal path or method returns Plat5 404 envelope", async (t) => {
  const { url } = await serve(t)
  for (const [method, path] of [
    ["GET", "/nope"],
    ["POST", "/health/live"],
    ["DELETE", "/metrics"]
  ] as const) {
    const res = await fetch(`${url}${path}`, { method, headers: { "x-request-id": "r1" } })
    assert.equal(res.status, 404, `${method} ${path}`)
    assert.deepEqual(await res.json(), {
      error: {
        type: "invalid_request_error",
        code: "NOT_FOUND",
        message: "Resource not found.",
        request_id: "r1",
        details: { resource: "resource", id: null }
      }
    })
  }
})

test("OTel diag logger emits structured error lines through Pino", (t) => {
  const { log, entries } = memoryLogger()
  diag.setLogger(createDiagLogger(log), DiagLogLevel.WARN)
  t.after(() => diag.disable())

  diag.error("traces export: connection refused")
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.level, "error")
  assert.equal(entries[0]?.message, "telemetry error")
  assert.equal(entries[0]?.error_message, "traces export: connection refused")
})
