import { accessClient } from "./access.ts"
import { buildApp } from "./app.ts"
import { loadConfig } from "./config.ts"
import { connect, migrate } from "./db.ts"
import { errorMessage } from "./errors.ts"
import { createInternalServer } from "./internal.ts"
import { lifecycleReader } from "./lifecycle.ts"
import { profilesStore } from "./profiles.ts"
import { tasksStore } from "./tasks.ts"
import { initTelemetry } from "./telemetry.ts"

const config = loadConfig()
const telemetry = initTelemetry(config)

const db = connect(config.databasePath)
migrate(db)
const tasks = tasksStore(db)
const profiles = profilesStore(db)

const app = await buildApp({
  tasks,
  profiles,
  access: accessClient(config.identityInternalUrl),
  assigneePermission: config.taskAssigneePermission,
  version: config.version,
  observeRequest: telemetry.observeRequest
})
telemetry.setLogger(app.log)

const internal = createInternalServer(db, telemetry.metrics)

const stopping = new AbortController()
let following: Promise<void> = Promise.resolve()
let shuttingDown: Promise<void> | undefined

const closeAll = async () => {
  stopping.abort()
  await app.close()
  if (internal.listening) {
    await new Promise<void>((resolve) => internal.close(() => resolve()))
  }
  await following
  db.close()
  await telemetry.shutdown()
}

const shutdown = (signal: string) => {
  if (shuttingDown) return shuttingDown
  app.log.info({ signal }, "shutting down")
  shuttingDown = closeAll().then(
    () => process.exit(0),
    (err) => {
      app.log.error({ error_message: errorMessage(err) }, "shutdown failed")
      process.exit(1)
    }
  )
  return shuttingDown
}

process.on("SIGINT", () => void shutdown("SIGINT"))
process.on("SIGTERM", () => void shutdown("SIGTERM"))

try {
  await new Promise<void>((resolve, reject) => {
    internal.once("error", reject)
    internal.listen(config.internalPort, "0.0.0.0", () => {
      internal.off("error", reject)
      resolve()
    })
  })
  await app.listen({ port: config.port, host: "0.0.0.0" })
} catch (err) {
  app.log.error({ error_message: errorMessage(err) }, "startup failed")
  await closeAll().catch(() => {})
  process.exit(1)
}

app.log.info({ port: config.port, internal_port: config.internalPort }, "api server started")

if (config.identityInternalUrl !== undefined) {
  following = lifecycleReader({
    identityUrl: config.identityInternalUrl,
    db,
    tasks,
    profiles,
    log: app.log
  }).run(stopping.signal)
} else {
  app.log.warn(
    "IDENTITY_INTERNAL_URL is unset: lifecycle log is disabled and assignee checks will return 503"
  )
}
