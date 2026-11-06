import { VERSION } from "./version.js"

/** The environment's variables, as `process.env` has them. */
export type Env = Readonly<Record<string, string | undefined>>

const optionalNonEmpty = (name: string, env: Env = process.env): string | undefined => {
  const raw = env[name]
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  return trimmed === "" ? undefined : trimmed
}

/** A variable as set, or undefined when unset or empty (Go's os.Getenv(name) == ""). */
const optionalSet = (name: string): string | undefined => {
  const raw = process.env[name]
  return raw === undefined || raw === "" ? undefined : raw
}

/**
 * A comma-separated OTEL_*_EXPORTER value, lowercased: undefined when unset or empty (the
 * default applies). A value outside `allowed` stops the API.
 */
const exporterList = (name: string, allowed: ReadonlyArray<string>): string[] | undefined => {
  const raw = optionalNonEmpty(name)
  if (raw === undefined) return undefined
  const list = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0)
  for (const exporter of list) {
    if (!allowed.includes(exporter)) {
      throw new Error(`${name} is "${raw}": want a comma-separated list of ${allowed.join(", ")}`)
    }
  }
  return list.length > 0 ? list : undefined
}

/**
 * OTEL_RESOURCE_ATTRIBUTES, `key=value,…` with percent-encoded values. An entry without
 * `=` or a key stops the API.
 */
const parseResourceAttributes = (raw: string | undefined): Record<string, string> => {
  if (raw === undefined) return {}
  const out: Record<string, string> = {}
  for (const entry of raw.split(",")) {
    const eq = entry.indexOf("=")
    const key = eq >= 0 ? entry.slice(0, eq).trim() : ""
    if (!key) throw new Error(`OTEL_RESOURCE_ATTRIBUTES is "${raw}": want key=value entries, comma-separated`)
    try {
      out[key] = decodeURIComponent(entry.slice(eq + 1).trim())
    } catch {
      throw new Error(`OTEL_RESOURCE_ATTRIBUTES is "${raw}": want percent-encoded values`)
    }
  }
  return out
}

/**
 * The resource (plat5 docs/reference/telemetry.md#resource-identity), layered: the
 * service's defaults (the build's `version` among them), then OTEL_RESOURCE_ATTRIBUTES and
 * OTEL_SERVICE_NAME, then the convenience variables that are set.
 */
export const serviceResource = (env: Env, version: string): Record<string, string> => {
  const get = (name: string) => optionalNonEmpty(name, env)
  const resource: Record<string, string> = {
    "service.name": "api",
    "service.namespace": "api",
    "service.instance.id": get("HOSTNAME") ?? "api-local",
    "service.version": version,
    "deployment.environment": "development",
    ...parseResourceAttributes(get("OTEL_RESOURCE_ATTRIBUTES"))
  }
  const name = get("OTEL_SERVICE_NAME")
  if (name !== undefined) resource["service.name"] = name
  const convenience = [
    ["service.namespace", get("OTEL_SERVICE_NAMESPACE")],
    ["service.version", get("OTEL_SERVICE_VERSION")],
    ["service.instance.id", get("OTEL_SERVICE_INSTANCE_ID")],
    ["deployment.environment", get("OTEL_DEPLOYMENT_ENV") ?? get("DEPLOYMENT_ENV")]
  ] as const
  for (const [key, value] of convenience) {
    if (value !== undefined) resource[key] = value
  }
  return resource
}

/** An OTLP endpoint variable: undefined when unset, else an http:// or https:// URL. */
const endpoint = (name: string): URL | undefined => {
  const raw = optionalNonEmpty(name)
  if (raw === undefined) return undefined
  const url = URL.parse(raw)
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:") || url.host === "") {
    throw new Error(`${name} is "${raw}": want an http:// or https:// URL`)
  }
  return url
}

/**
 * An OTLP destination: the per-signal URL, else the base URL with `path`. Undefined when
 * neither is set.
 */
const otlpDestination = (signal: "TRACES" | "METRICS", path: string): string | undefined => {
  const own = endpoint(`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`)
  if (own !== undefined) {
    // A per-signal URL without a path gets the signal's.
    if (own.pathname === "/") own.pathname = path
    return own.toString()
  }
  const base = endpoint("OTEL_EXPORTER_OTLP_ENDPOINT")
  if (base === undefined) return undefined
  base.pathname = `${base.pathname.replace(/\/$/, "")}${path}`
  return base.toString()
}

/** The only OTLP protocol the exporters speak is http/protobuf; any other stops the API. */
const checkProtocol = (): void => {
  for (const name of [
    "OTEL_EXPORTER_OTLP_PROTOCOL",
    "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
    "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL"
  ]) {
    const value = optionalNonEmpty(name)
    if (value !== undefined && value !== "http/protobuf") {
      throw new Error(`${name} is "${value}": only http/protobuf is supported`)
    }
  }
}

/** OTEL_SDK_DISABLED: unset or empty is false, else true or false. */
const sdkDisabled = (): boolean => {
  const raw = optionalNonEmpty("OTEL_SDK_DISABLED")
  if (raw === undefined) return false
  const value = raw.toLowerCase()
  if (value === "true") return true
  if (value === "false") return false
  throw new Error(`OTEL_SDK_DISABLED is "${raw}": want true or false`)
}

/** OTEL_TRACES_SAMPLER_RATIO: unset is 1, else a number from 0 to 1. */
const samplerRatio = (): number => {
  const raw = optionalNonEmpty("OTEL_TRACES_SAMPLER_RATIO")
  if (raw === undefined) return 1
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`OTEL_TRACES_SAMPLER_RATIO is "${raw}": want a number from 0 to 1`)
  }
  return n
}

/** OTEL_METRIC_EXPORT_INTERVAL, in ms: unset is 60000, else a positive whole number. */
const metricExportInterval = (): number => {
  const raw = optionalNonEmpty("OTEL_METRIC_EXPORT_INTERVAL")
  if (raw === undefined) return 60_000
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`OTEL_METRIC_EXPORT_INTERVAL is "${raw}": want a positive number of milliseconds`)
  }
  return n
}

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === "") return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : fallback
}

export type AppConfig = {
  readonly port: number
  readonly internalPort: number
  readonly databasePath: string
  /**
   * Identity's internal base URL, for its lifecycle log and the assignee check.
   * Unset: the log isn't read, and a task with an assignee is a 503.
   */
  readonly identityInternalUrl: string | undefined
  /**
   * The permission a task's assignee needs on its project: the deployment's name for it,
   * never the code's.
   */
  readonly taskAssigneePermission: string
  /** The OpenTelemetry resource: service.name, service.version and the rest. */
  readonly resource: Readonly<Record<string, string>>
  /** Where traces go, or undefined for no OTLP traces. */
  readonly otlpTracesUrl: string | undefined
  /** Where metrics go, or undefined for no OTLP metrics. `/metrics` is on regardless. */
  readonly otlpMetricsUrl: string | undefined
  readonly metricExportIntervalMs: number
  readonly tracesSamplerRatio: number
}

/** A permission's name as Plat5's roles write it. */
const PERMISSION_NAME = /^[a-z0-9:._-]{1,64}$/

/**
 * Reads the config from the environment. Throws when `TASK_ASSIGNEE_PERMISSION`, the one
 * it requires, is unset or isn't a permission name, or when a telemetry variable is set
 * but invalid, naming it (plat5 docs/reference/telemetry.md#invalid-values): the API
 * won't start.
 *
 * OTLP (plat5 docs/reference/telemetry.md): with a destination, traces and metrics are
 * both pushed unless OTEL_TRACES_EXPORTER / OTEL_METRICS_EXPORTER leave `otlp` out, or
 * OTEL_SDK_DISABLED is true.
 */

export const loadConfig = (): AppConfig => {
  const taskAssigneePermission = optionalSet("TASK_ASSIGNEE_PERMISSION")
  if (taskAssigneePermission === undefined || !PERMISSION_NAME.test(taskAssigneePermission)) {
    throw new Error(
      "TASK_ASSIGNEE_PERMISSION is unset or isn't a permission name ([a-z0-9:._-], at most 64 characters): set it to the permission an assignee needs on the task's project (the starter's is project:read)"
    )
  }
  const disabled = sdkDisabled()
  checkProtocol()
  const tracesExporters = exporterList("OTEL_TRACES_EXPORTER", ["otlp", "none"])
  const metricsExporters = exporterList("OTEL_METRICS_EXPORTER", ["otlp", "prometheus", "none"])
  const tracesSamplerRatio = samplerRatio()
  const metricExportIntervalMs = metricExportInterval()
  const resource = serviceResource(process.env, VERSION)
  endpoint("OTEL_EXPORTER_OTLP_ENDPOINT")
  const tracesUrl = otlpDestination("TRACES", "/v1/traces")
  const metricsUrl = otlpDestination("METRICS", "/v1/metrics")
  return {
    port: envInt("PORT", 3000),
    internalPort: envInt("INTERNAL_PORT", 3001),
    databasePath: optionalSet("DATABASE_PATH") ?? "./data/app.db",
    identityInternalUrl: optionalSet("IDENTITY_INTERNAL_URL"),
    taskAssigneePermission,
    resource,
    otlpTracesUrl:
      !disabled && (tracesExporters?.includes("otlp") ?? true) ? tracesUrl : undefined,
    otlpMetricsUrl:
      !disabled && (metricsExporters?.includes("otlp") ?? true) ? metricsUrl : undefined,
    metricExportIntervalMs,
    tracesSamplerRatio
  }
}
