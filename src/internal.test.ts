import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import { after, test, type TestContext } from "node:test"
import { loadConfig } from "./config.ts"
import { connect, migrate, trackDb } from "./db.ts"
import { createInternalServer } from "./internal.ts"
import { observeRequest } from "./metrics.ts"
import { initTelemetry } from "./telemetry.ts"

// No OTLP: the series go to the /metrics scrape only.
const telemetry = initTelemetry(loadConfig({ TASK_ASSIGNEE_PERMISSION: "project:read" }))
after(() => telemetry.shutdown())

const serve = async (t: TestContext) => {
  const db = connect(":memory:")
  migrate(db)
  const server = createInternalServer(db, telemetry.metrics)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => server.close())
  return { db, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

test("health: live, and ready while the database answers", async (t) => {
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

test("/metrics: the contract's series, names and labels, and the process ones", async (t) => {
  const { url } = await serve(t)
  observeRequest("GET", "/projects/:project_id/tasks", 200, 0.003)
  trackDb("tasks.list", () => 1)
  assert.throws(() =>
    trackDb("tasks.insert", () => {
      throw new Error("busy")
    })
  )
  const res = await fetch(`${url}/metrics`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get("content-type") ?? "", /^text\/plain/)
  const text = await res.text()
  const db = `db_system_name="sqlite",db_operation_name="tasks.insert",db_namespace="api"`
  for (const series of [
    `http_requests_total{method="GET",route="/projects/:project_id/tasks",status="200"} 1`,
    `http_request_duration_seconds_bucket{method="GET",route="/projects/:project_id/tasks",le="0.005"} 1`,
    `http_request_duration_seconds_bucket{method="GET",route="/projects/:project_id/tasks",le="5"} 1`,
    `db_operations_total{${db}} 1`,
    `db_operation_errors_total{${db}} 1`,
    `db_operation_duration_seconds_bucket{${db},le="0.001"} 1`,
    `db_operation_duration_seconds_bucket{${db},le="1"} 1`
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
  // No scope labels, no target_info.
  assert.equal(text.includes("otel_scope"), false)
  assert.equal(text.includes("target_info"), false)
})

test("another path or method is the 404 envelope", async (t) => {
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
