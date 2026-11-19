import assert from "node:assert/strict"
import { test } from "node:test"
import { loadConfig } from "./config.ts"

const base = { TASK_ASSIGNEE_PERMISSION: "project:read" }

test("TASK_ASSIGNEE_PERMISSION is required and validated", () => {
  for (const value of [undefined, "", "  ", " project:read", "Project:Read", "a".repeat(65)]) {
    assert.throws(() => loadConfig({ TASK_ASSIGNEE_PERMISSION: value }), /TASK_ASSIGNEE_PERMISSION/)
  }
  assert.equal(
    loadConfig({ TASK_ASSIGNEE_PERMISSION: "tasks:assignable" }).taskAssigneePermission,
    "tasks:assignable"
  )
})

test("defaults and empty variables treated as unset", () => {
  const cfg = loadConfig({ ...base, IDENTITY_INTERNAL_URL: "", DATABASE_PATH: "  ", APP_VERSION: "" })
  assert.deepEqual(cfg, {
    port: 3000,
    internalPort: 3001,
    databasePath: "./data/app.db",
    identityInternalUrl: undefined,
    taskAssigneePermission: "project:read",
    otlpEndpoint: undefined,
    version: "dev"
  })
})

test("validates ports and URLs and strips trailing slashes", () => {
  const cfg = loadConfig({
    ...base,
    PORT: "8080",
    INTERNAL_PORT: "8081",
    IDENTITY_INTERNAL_URL: "http://identity:3001///",
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example:4318/",
    APP_VERSION: "v1.2.3"
  })
  assert.equal(cfg.port, 8080)
  assert.equal(cfg.internalPort, 8081)
  assert.equal(cfg.identityInternalUrl, "http://identity:3001")
  assert.equal(cfg.otlpEndpoint, "https://collector.example:4318")
  assert.equal(cfg.version, "v1.2.3")

  for (const value of ["http", "0", "70000", "80.5"]) {
    assert.throws(() => loadConfig({ ...base, PORT: value }), /PORT/)
  }
  for (const value of ["identity:3001", "ftp://identity:3001", "not a url"]) {
    assert.throws(() => loadConfig({ ...base, IDENTITY_INTERNAL_URL: value }), /IDENTITY_INTERNAL_URL/)
    assert.throws(
      () => loadConfig({ ...base, OTEL_EXPORTER_OTLP_ENDPOINT: value }),
      /OTEL_EXPORTER_OTLP_ENDPOINT/
    )
  }
})
