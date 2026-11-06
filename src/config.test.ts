import assert from "node:assert/strict"
import { test } from "node:test"
import { loadConfig } from "./config.js"

const setPermission = (value: string | undefined) => {
  if (value === undefined) delete process.env.TASK_ASSIGNEE_PERMISSION
  else process.env.TASK_ASSIGNEE_PERMISSION = value
}

const before = process.env.TASK_ASSIGNEE_PERMISSION
test.afterEach(() => setPermission(before))

test("TASK_ASSIGNEE_PERMISSION unset or not a permission name: the API won't start", () => {
  for (const value of [undefined, "", "  ", " project:read", "Project:Read", "a".repeat(65)]) {
    setPermission(value)
    assert.throws(loadConfig, {
      message:
        "TASK_ASSIGNEE_PERMISSION is unset or isn't a permission name ([a-z0-9:._-], at most 64 characters): set it to the permission an assignee needs on the task's project (the starter's is project:read)"
    })
  }
})

test("TASK_ASSIGNEE_PERMISSION names the assignee's permission", () => {
  setPermission("tasks:assignable")
  assert.equal(loadConfig().taskAssigneePermission, "tasks:assignable")
})

const OTEL_VARIABLES = [
  "OTEL_SDK_DISABLED",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
  "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
  "OTEL_TRACES_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_TRACES_SAMPLER_RATIO",
  "OTEL_METRIC_EXPORT_INTERVAL",
  "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_SERVICE_NAME",
  "OTEL_SERVICE_VERSION",
  "OTEL_SERVICE_INSTANCE_ID",
  "CI_COMMIT_TAG",
  "HOSTNAME"
]

/** The config with `env` set and every other telemetry variable unset. */
const withOtel = (env: Record<string, string>) => {
  const saved = OTEL_VARIABLES.map((name) => [name, process.env[name]] as const)
  for (const name of OTEL_VARIABLES) delete process.env[name]
  Object.assign(process.env, env)
  setPermission("project:read")
  try {
    return loadConfig()
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

test("telemetry defaults: no OTLP without an endpoint", () => {
  const config = withOtel({})
  assert.equal(config.otlpTracesUrl, undefined)
  assert.equal(config.otlpMetricsUrl, undefined)
  assert.equal(config.serviceName, "api")
  assert.equal(config.serviceVersion, "0.0.0")
  assert.equal(config.serviceInstanceId, "api-local")
  assert.equal(config.tracesSamplerRatio, 1)
  assert.equal(config.metricExportIntervalMs, 60_000)
})

test("telemetry defaults: an endpoint pushes traces and metrics", () => {
  const config = withOtel({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/" })
  assert.equal(config.otlpTracesUrl, "http://collector:4318/v1/traces")
  assert.equal(config.otlpMetricsUrl, "http://collector:4318/v1/metrics")
})

test("telemetry: the exporters and OTEL_SDK_DISABLED turn a signal's push off", () => {
  const endpoint = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" }
  const scrape = withOtel({ ...endpoint, OTEL_METRICS_EXPORTER: "prometheus" })
  assert.equal(scrape.otlpTracesUrl, "http://collector:4318/v1/traces")
  assert.equal(scrape.otlpMetricsUrl, undefined)
  const none = withOtel({ ...endpoint, OTEL_TRACES_EXPORTER: "none" })
  assert.equal(none.otlpTracesUrl, undefined)
  const disabled = withOtel({ ...endpoint, OTEL_SDK_DISABLED: "true" })
  assert.equal(disabled.otlpTracesUrl, undefined)
  assert.equal(disabled.otlpMetricsUrl, undefined)
  const own = withOtel({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://traces.example" })
  assert.equal(own.otlpTracesUrl, "https://traces.example/v1/traces")
  assert.equal(own.otlpMetricsUrl, undefined)
})

test("telemetry: a variable set but invalid stops the API", () => {
  for (const [name, value] of [
    ["OTEL_SDK_DISABLED", "yes"],
    ["OTEL_EXPORTER_OTLP_PROTOCOL", "grpc"],
    ["OTEL_EXPORTER_OTLP_TRACES_PROTOCOL", "http/json"],
    ["OTEL_EXPORTER_OTLP_METRICS_PROTOCOL", "grpc"],
    ["OTEL_TRACES_EXPORTER", "zipkin"],
    ["OTEL_METRICS_EXPORTER", "console"],
    ["OTEL_TRACES_SAMPLER_RATIO", "1.5"],
    ["OTEL_METRIC_EXPORT_INTERVAL", "30s"],
    ["OTEL_EXPORTER_OTLP_ENDPOINT", "collector:4318"],
    ["OTEL_RESOURCE_ATTRIBUTES", "service.version"]
  ] as const) {
    assert.throws(() => withOtel({ [name]: value }), new RegExp(`^Error: ${name}`), name)
  }
})
