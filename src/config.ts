import { hostname } from "node:os"

const optionalNonEmpty = (name: string): string | undefined => {
  const raw = process.env[name]
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  return trimmed === "" ? undefined : trimmed
}

const optionalExporterList = (name: string): string[] | undefined => {
  const raw = optionalNonEmpty(name)
  if (raw === undefined) return undefined
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0)
}

const parseResourceAttributes = (raw: string | undefined): Record<string, string> => {
  if (!raw) return {}
  const out: Record<string, string> = {}
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf("=")
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (key) out[key] = value
  }
  return out
}

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === "") return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : fallback
}

const envNumber = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === "") return fallback
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) ? n : fallback
}

const envBool = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === "") return fallback
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase())
}

export type AppConfig = {
  readonly port: number
  readonly internalPort: number
  readonly databasePath: string
  readonly serviceName: string
  readonly serviceNamespace: string
  readonly serviceVersion: string
  readonly serviceInstanceId: string
  readonly deploymentEnv: string
  readonly resourceAttributes: Readonly<Record<string, string>>
  readonly otlpEndpoint: string | undefined
  readonly otlpTracesEndpoint: string | undefined
  readonly otlpMetricsEndpoint: string | undefined
  readonly tracesExporters: ReadonlyArray<string> | undefined
  readonly metricsExporters: ReadonlyArray<string> | undefined
  readonly otelSdkDisabled: boolean
  readonly metricExportIntervalMs: number
  readonly tracesSamplerRatio: number
}

export const loadConfig = (): AppConfig => {
  const deploymentEnvOtel = optionalNonEmpty("OTEL_DEPLOYMENT_ENV")
  return {
    port: envInt("PORT", 3000),
    internalPort: envInt("INTERNAL_PORT", 3001),
    databasePath: optionalNonEmpty("DATABASE_PATH") ?? "./data/app.db",
    serviceName: optionalNonEmpty("OTEL_SERVICE_NAME") ?? "api",
    serviceNamespace: optionalNonEmpty("OTEL_SERVICE_NAMESPACE") ?? "api",
    serviceVersion: optionalNonEmpty("OTEL_SERVICE_VERSION") ?? "0.0.0",
    serviceInstanceId: optionalNonEmpty("OTEL_SERVICE_INSTANCE_ID") ?? hostname(),
    deploymentEnv:
      deploymentEnvOtel ?? optionalNonEmpty("DEPLOYMENT_ENV") ?? "development",
    resourceAttributes: parseResourceAttributes(
      optionalNonEmpty("OTEL_RESOURCE_ATTRIBUTES")
    ),
    otlpEndpoint: optionalNonEmpty("OTEL_EXPORTER_OTLP_ENDPOINT"),
    otlpTracesEndpoint: optionalNonEmpty("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"),
    otlpMetricsEndpoint: optionalNonEmpty("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"),
    tracesExporters: optionalExporterList("OTEL_TRACES_EXPORTER"),
    metricsExporters: optionalExporterList("OTEL_METRICS_EXPORTER"),
    otelSdkDisabled: envBool("OTEL_SDK_DISABLED", false),
    metricExportIntervalMs: envInt("OTEL_METRIC_EXPORT_INTERVAL", 30_000),
    tracesSamplerRatio: envNumber("OTEL_TRACES_SAMPLER_RATIO", 1)
  }
}
