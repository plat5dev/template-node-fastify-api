import { metrics, type Counter, type Histogram } from "@opentelemetry/api"
import client from "prom-client"

const dbSystemName = "sqlite"
const dbNamespace = "app"

const HTTP_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]
const DB_DURATION_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1]

let initialized = false

const httpDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route"] as const,
  buckets: HTTP_DURATION_BUCKETS
})

const httpTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total HTTP requests processed",
  labelNames: ["method", "route", "status"] as const
})

const dbOpsTotal = new client.Counter({
  name: "db_operations_total",
  help: "Total database operations",
  labelNames: ["db_system_name", "db_operation_name", "db_namespace"] as const
})

const dbOpsErrors = new client.Counter({
  name: "db_operation_errors_total",
  help: "Total failed database operations",
  labelNames: ["db_system_name", "db_operation_name", "db_namespace"] as const
})

const dbOpsDuration = new client.Histogram({
  name: "db_operation_duration_seconds",
  help: "Database operation duration in seconds",
  labelNames: ["db_system_name", "db_operation_name", "db_namespace"] as const,
  buckets: DB_DURATION_BUCKETS
})

/** OTEL dual-write instruments (no-op until MeterProvider is installed). */
type OtelInstruments = {
  httpRequests: Counter
  httpDuration: Histogram
  dbOps: Counter
  dbOpsErrors: Counter
  dbOpsDuration: Histogram
}

let otel: OtelInstruments | undefined

/**
 * Create OTEL instruments after MeterProvider is set (gateway dual-write pattern).
 * Safe to call when OTLP is off — instruments bind to the global (no-op) meter.
 */
export const initOtelInstruments = (): void => {
  if (otel) return
  const meter = metrics.getMeter("api")
  otel = {
    httpRequests: meter.createCounter("http_requests_total", {
      description: "Total HTTP requests processed"
    }),
    httpDuration: meter.createHistogram("http_request_duration_seconds", {
      description: "HTTP request duration in seconds",
      unit: "s",
      advice: { explicitBucketBoundaries: HTTP_DURATION_BUCKETS }
    }),
    dbOps: meter.createCounter("db_operations_total", {
      description: "Total database operations"
    }),
    dbOpsErrors: meter.createCounter("db_operation_errors_total", {
      description: "Total failed database operations"
    }),
    dbOpsDuration: meter.createHistogram("db_operation_duration_seconds", {
      description: "Database operation duration in seconds",
      unit: "s",
      advice: { explicitBucketBoundaries: DB_DURATION_BUCKETS }
    })
  }
}

export const initMetrics = (): void => {
  if (initialized) return
  initialized = true
  client.collectDefaultMetrics({ prefix: "" })
  client.register.registerMetric(httpDuration)
  client.register.registerMetric(httpTotal)
  client.register.registerMetric(dbOpsTotal)
  client.register.registerMetric(dbOpsErrors)
  client.register.registerMetric(dbOpsDuration)
}

export const observeRequest = (
  method: string,
  route: string,
  status: number,
  durationSeconds: number
): void => {
  initMetrics()
  const r = route || "unknown"
  const m = method || "UNKNOWN"
  const statusS = String(status)
  httpTotal.inc({ method: m, route: r, status: statusS })
  httpDuration.observe({ method: m, route: r }, durationSeconds)
  if (otel) {
    otel.httpRequests.add(1, { method: m, route: r, status: statusS })
    otel.httpDuration.record(durationSeconds, { method: m, route: r })
  }
}

export const recordDbOperation = (
  operation: string,
  durationSeconds: number,
  err: unknown
): void => {
  initMetrics()
  const op = operation || "unknown"
  const labels = {
    db_system_name: dbSystemName,
    db_operation_name: op,
    db_namespace: dbNamespace
  }
  dbOpsTotal.inc(labels)
  dbOpsDuration.observe(labels, durationSeconds)
  if (err) dbOpsErrors.inc(labels)
  if (otel) {
    otel.dbOps.add(1, labels)
    otel.dbOpsDuration.record(durationSeconds, labels)
    if (err) otel.dbOpsErrors.add(1, labels)
  }
}

export const collectMetrics = async (): Promise<string> => {
  initMetrics()
  return client.register.metrics()
}

export const metricsContentType = (): string => client.register.contentType
