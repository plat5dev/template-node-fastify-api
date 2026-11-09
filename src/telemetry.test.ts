import { diag, DiagLogLevel } from "@opentelemetry/api"
import assert from "node:assert/strict"
import { test } from "node:test"
import { diagLogger } from "./telemetry.ts"

// A failed export reaches OpenTelemetry's diagnostic logger, which writes one JSON line.
test("a failed export is one JSON error line", (t) => {
  const logs = t.mock.method(console, "log", () => undefined)
  diag.setLogger(diagLogger, DiagLogLevel.WARN)
  t.after(() => diag.disable())

  diag.error("traces export: connection refused")

  assert.equal(logs.mock.callCount(), 1)
  const line = JSON.parse(String(logs.mock.calls[0]?.arguments[0])) as Record<string, unknown>
  assert.equal(line.level, "error")
  assert.equal(line.message, "telemetry error")
  assert.equal(line.error_message, "traces export: connection refused")
  assert.equal(typeof line.timestamp, "string")
})
