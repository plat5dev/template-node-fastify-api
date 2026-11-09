/**
 * The series plat5 docs/reference/telemetry.md#metrics names, each written once to the
 * OpenTelemetry meter: telemetry.ts reads it for the `/metrics` scrape, and pushes it over
 * OTLP when that's on. Until `initMetrics` they go nowhere.
 */
import type { Counter, Histogram, Meter } from "@opentelemetry/api"

const HTTP_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]
const DB_DURATION_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1]

type Instruments = {
  httpRequests: Counter
  httpDuration: Histogram
  dbOps: Counter
  dbOpsErrors: Counter
  dbOpsDuration: Histogram
}

let instruments: Instruments | undefined

/** Makes the series on `meter`, the process ones among them. */
export const initMetrics = (meter: Meter): void => {
  instruments = {
    httpRequests: meter.createCounter("http_requests_total", {
      description: "Total HTTP requests handled by the api service"
    }),
    httpDuration: meter.createHistogram("http_request_duration_seconds", {
      description: "HTTP request latency observed by the api service",
      unit: "s",
      advice: { explicitBucketBoundaries: HTTP_DURATION_BUCKETS }
    }),
    dbOps: meter.createCounter("db_operations_total", { description: "Total database operations" }),
    dbOpsErrors: meter.createCounter("db_operation_errors_total", {
      description: "Total failed database operations"
    }),
    dbOpsDuration: meter.createHistogram("db_operation_duration_seconds", {
      description: "Database operation duration in seconds",
      unit: "s",
      advice: { explicitBucketBoundaries: DB_DURATION_BUCKETS }
    })
  }
  const startTime = Date.now() / 1000 - process.uptime()
  meter
    .createObservableGauge("process_resident_memory_bytes", {
      description: "Resident memory size in bytes"
    })
    .addCallback((result) => result.observe(process.memoryUsage.rss()))
  meter
    .createObservableCounter("process_cpu_seconds_total", {
      description: "Total user and system CPU time spent in seconds"
    })
    .addCallback((result) => {
      const usage = process.cpuUsage()
      result.observe((usage.user + usage.system) / 1_000_000)
    })
  meter
    .createObservableGauge("process_start_time_seconds", {
      description: "Start time of the process since unix epoch in seconds"
    })
    .addCallback((result) => result.observe(startTime))
}

export const observeRequest = (
  method: string,
  route: string,
  status: number,
  seconds: number
): void => {
  instruments?.httpRequests.add(1, { method, route, status: String(status) })
  instruments?.httpDuration.record(seconds, { method, route })
}

export const recordDbOperation = (operation: string, seconds: number, failed: boolean): void => {
  const labels = { db_system_name: "sqlite", db_operation_name: operation, db_namespace: "api" }
  instruments?.dbOps.add(1, labels)
  instruments?.dbOpsDuration.record(seconds, labels)
  if (failed) instruments?.dbOpsErrors.add(1, labels)
}
