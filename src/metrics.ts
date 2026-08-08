import client from "prom-client"

const dbSystemName = "sqlite"
const dbNamespace = "app"

let initialized = false

const httpDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]
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
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1]
})

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
  httpTotal.inc({ method: m, route: r, status: String(status) })
  httpDuration.observe({ method: m, route: r }, durationSeconds)
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
}

export const collectMetrics = async (): Promise<string> => {
  initMetrics()
  return client.register.metrics()
}

export const metricsContentType = (): string => client.register.contentType
