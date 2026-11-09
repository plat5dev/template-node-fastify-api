import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { loadConfig, serviceResource } from "./config.ts"

const permission = { TASK_ASSIGNEE_PERMISSION: "project:read" }

/** The config from `env` and the permission, nothing else set. */
const withOtel = (env: Record<string, string>) => loadConfig({ ...permission, ...env })

test("TASK_ASSIGNEE_PERMISSION unset or not a permission name: the API won't start", () => {
  for (const value of [undefined, "", "  ", " project:read", "Project:Read", "a".repeat(65)]) {
    assert.throws(() => loadConfig({ TASK_ASSIGNEE_PERMISSION: value }), {
      message:
        "TASK_ASSIGNEE_PERMISSION is unset or isn't a permission name ([a-z0-9:._-], at most 64 characters): set it to the permission an assignee needs on the task's project (the starter's is project:read)"
    })
  }
})

test("TASK_ASSIGNEE_PERMISSION names the assignee's permission", () => {
  assert.equal(
    loadConfig({ TASK_ASSIGNEE_PERMISSION: "tasks:assignable" }).taskAssigneePermission,
    "tasks:assignable"
  )
})

test("the app's settings: defaults, and an empty variable is unset", () => {
  const config = withOtel({ IDENTITY_INTERNAL_URL: "", DATABASE_PATH: "" })
  assert.deepEqual(
    [config.port, config.internalPort, config.databasePath, config.identityInternalUrl],
    [3000, 3001, "./data/app.db", undefined]
  )
  const set = withOtel({
    PORT: "8080",
    INTERNAL_PORT: "8081",
    IDENTITY_INTERNAL_URL: "http://identity:3001"
  })
  assert.deepEqual(
    [set.port, set.internalPort, set.identityInternalUrl],
    [8080, 8081, "http://identity:3001"]
  )
  for (const value of ["http", "0", "70000", "80.5"]) {
    assert.throws(() => withOtel({ PORT: value }), {
      message: `PORT is "${value}": want a port number`
    })
  }
})

test("telemetry defaults: no OTLP without an endpoint", () => {
  const config = withOtel({})
  assert.equal(config.otlpTracesUrl, undefined)
  assert.equal(config.otlpMetricsUrl, undefined)
  assert.deepEqual(config.resource, {
    "service.name": "api",
    "service.namespace": "api",
    "service.instance.id": "api-local",
    "service.version": "dev",
    "deployment.environment": "development"
  })
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

// Each set-but-invalid value in telemetry.md's "Invalid values" table stops the API at
// boot, with an error naming the variable.
test("telemetry: a variable set but invalid stops the API, naming it", () => {
  for (const [name, value] of [
    ["OTEL_TRACES_EXPORTER", "jaeger"],
    ["OTEL_TRACES_EXPORTER", "otlp,prometheus"],
    ["OTEL_METRICS_EXPORTER", "otlp,statsd"],
    ["OTEL_EXPORTER_OTLP_PROTOCOL", "grpc"],
    ["OTEL_EXPORTER_OTLP_TRACES_PROTOCOL", "http/json"],
    ["OTEL_EXPORTER_OTLP_METRICS_PROTOCOL", "grpc"],
    ["OTEL_EXPORTER_OTLP_ENDPOINT", "localhost:4318"],
    ["OTEL_EXPORTER_OTLP_ENDPOINT", "grpc://collector:4317"],
    ["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "ftp://collector/v1/traces"],
    ["OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "collector"],
    ["OTEL_TRACES_SAMPLER_RATIO", "1.5"],
    ["OTEL_TRACES_SAMPLER_RATIO", "-0.1"],
    ["OTEL_TRACES_SAMPLER_RATIO", "half"],
    ["OTEL_METRIC_EXPORT_INTERVAL", "0"],
    ["OTEL_METRIC_EXPORT_INTERVAL", "10s"],
    ["OTEL_SDK_DISABLED", "yes"],
    ["OTEL_RESOURCE_ATTRIBUTES", "service.namespace"],
    ["OTEL_RESOURCE_ATTRIBUTES", "a=b,=c"]
  ] as const) {
    assert.throws(
      () => withOtel({ [name]: value }),
      (err: Error) =>
        err.message.startsWith(`${name} is "${value}": want `) ||
        err.message === `${name} is "${value}": only http/protobuf is supported`,
      `${name}=${value}`
    )
  }
})

test("telemetry: valid values are accepted", () => {
  withOtel({
    OTEL_TRACES_EXPORTER: "otlp,none",
    OTEL_METRICS_EXPORTER: "prometheus,none",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example",
    OTEL_TRACES_SAMPLER_RATIO: "0.25",
    OTEL_METRIC_EXPORT_INTERVAL: "5000",
    OTEL_SDK_DISABLED: "true",
    OTEL_RESOURCE_ATTRIBUTES: "service.namespace=edge,deployment.environment=dev",
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: ""
  })
})

test("an invalid telemetry value stops the API at boot, naming the variable", () => {
  const main = fileURLToPath(new URL("./main.ts", import.meta.url))
  const run = spawnSync(process.execPath, [main], {
    cwd: tmpdir(),
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      TASK_ASSIGNEE_PERMISSION: "project:read",
      OTEL_TRACES_SAMPLER_RATIO: "2"
    }
  })
  assert.equal(run.status, 1)
  assert.match(
    `${run.stdout}${run.stderr}`,
    /OTEL_TRACES_SAMPLER_RATIO is "2": want a number from 0 to 1/
  )
})

// service.version: OTEL_SERVICE_VERSION, then OTEL_RESOURCE_ATTRIBUTES, then the build's
// VERSION, which is dev without one. CI_COMMIT_TAG plays no part.
test("service.version: the build's VERSION, else dev; the variables override it", () => {
  const ci = { CI_COMMIT_TAG: "v9.9.9" }
  assert.equal(withOtel(ci).resource["service.version"], "dev")
  assert.equal(serviceResource({}, "v1.2.3")["service.version"], "v1.2.3")
  const bag = { OTEL_RESOURCE_ATTRIBUTES: "service.version=v2.0.0" }
  assert.equal(serviceResource(bag, "v1.2.3")["service.version"], "v2.0.0")
  assert.equal(withOtel({ ...ci, ...bag }).resource["service.version"], "v2.0.0")
  const own = { ...bag, OTEL_SERVICE_VERSION: "v3.0.0" }
  assert.equal(serviceResource(own, "v1.2.3")["service.version"], "v3.0.0")
  assert.equal(withOtel({ ...ci, ...own }).resource["service.version"], "v3.0.0")
})

test("the resource: defaults, then OTEL_RESOURCE_ATTRIBUTES and OTEL_SERVICE_NAME, then the convenience variables", () => {
  const bag = withOtel({
    HOSTNAME: "host-1",
    OTEL_RESOURCE_ATTRIBUTES:
      "service.name=bag,service.namespace=edge,service.instance.id=i-1,team=a%20b"
  })
  assert.deepEqual(bag.resource, {
    "service.name": "bag",
    "service.namespace": "edge",
    "service.instance.id": "i-1",
    "service.version": "dev",
    "deployment.environment": "development",
    team: "a b"
  })
  const vars = withOtel({
    OTEL_RESOURCE_ATTRIBUTES: "service.name=bag,service.namespace=edge,deployment.environment=bag",
    OTEL_SERVICE_NAME: "named",
    OTEL_SERVICE_NAMESPACE: "ns",
    OTEL_SERVICE_INSTANCE_ID: "i-2",
    DEPLOYMENT_ENV: "staging"
  })
  assert.deepEqual(vars.resource, {
    "service.name": "named",
    "service.namespace": "ns",
    "service.instance.id": "i-2",
    "service.version": "dev",
    "deployment.environment": "staging"
  })
  assert.equal(
    withOtel({ DEPLOYMENT_ENV: "staging", OTEL_DEPLOYMENT_ENV: "prod" }).resource[
      "deployment.environment"
    ],
    "prod"
  )
})
