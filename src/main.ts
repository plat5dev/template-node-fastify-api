import "dotenv/config"
import { AccessClient } from "./access.js"
import { buildApp } from "./app.js"
import { loadConfig } from "./config.js"
import { connect, migrate, type Db } from "./db.js"
import { createInternalServer } from "./internal.js"
import { LifecycleConsumer } from "./lifecycle.js"
import { initMetrics } from "./metrics.js"
import { ProfilesStore } from "./profiles/store.js"
import { TasksStore } from "./tasks/store.js"
import { initTelemetry } from "./telemetry.js"

const config = loadConfig()
const telemetry = initTelemetry(config)
initMetrics()

const db: Db = connect(config.databasePath)
migrate(db)

const profiles = new ProfilesStore(db)
const tasks = new TasksStore(db)

const app = await buildApp({
  tasks,
  profiles,
  access: new AccessClient(config.identityInternalUrl),
  assigneePermission: config.taskAssigneePermission,
  docsVersion: config.serviceVersion
})

const internal = createInternalServer(db)

const lifecycle = config.identityInternalUrl
  ? new LifecycleConsumer(config.identityInternalUrl, db, tasks, profiles)
  : undefined

const shutdown = async (signal: string) => {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "info",
      message: "shutting down",
      signal
    })
  )
  lifecycle?.stop()
  await app.close()
  await new Promise<void>((resolve) => internal.close(() => resolve()))
  db.close()
  await telemetry.shutdown()
  process.exit(0)
}

process.on("SIGINT", () => void shutdown("SIGINT"))
process.on("SIGTERM", () => void shutdown("SIGTERM"))

await new Promise<void>((resolve) => {
  internal.listen(config.internalPort, "0.0.0.0", () => resolve())
})

await app.listen({ port: config.port, host: "0.0.0.0" })

console.log(
  JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "info",
    message: "starting api server",
    port: config.port,
    internal_port: config.internalPort
  })
)

if (lifecycle) {
  lifecycle.start()
} else {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "warn",
      message:
        "IDENTITY_INTERNAL_URL is unset: not reading identity's feeds, so a purged environment's tasks and a deleted person's profile are kept, and a task's assignee can't be checked (503)"
    })
  )
}
