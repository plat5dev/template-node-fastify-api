import { accessClient } from "./access.ts"
import { buildApp } from "./app.ts"
import { loadConfig } from "./config.ts"
import { connect, migrate } from "./db.ts"
import { createInternalServer } from "./internal.ts"
import { lifecycleReader } from "./lifecycle.ts"
import { log } from "./log.ts"
import { profilesStore } from "./profiles/store.ts"
import { tasksStore } from "./tasks/store.ts"
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
  version: config.resource["service.version"] ?? "dev"
})
const internal = createInternalServer(db, telemetry.metrics)

// SIGINT or SIGTERM aborts it: the lifecycle reader stops, its read in flight cancelled.
const stopping = new AbortController()
let following: Promise<void> = Promise.resolve()

const shutdown = async (signal: string) => {
  log("info", "shutting down", { signal })
  stopping.abort()
  await app.close()
  await new Promise<void>((resolve) => internal.close(() => resolve()))
  // Wait for the reader, so its last transaction ends before the database closes.
  await following
  db.close()
  await telemetry.shutdown()
  process.exit(0)
}
process.on("SIGINT", () => void shutdown("SIGINT"))
process.on("SIGTERM", () => void shutdown("SIGTERM"))

await new Promise<void>((resolve) => internal.listen(config.internalPort, "0.0.0.0", resolve))
await app.listen({ port: config.port, host: "0.0.0.0" })
log("info", "starting api server", { port: config.port, internal_port: config.internalPort })

if (config.identityInternalUrl !== undefined) {
  following = lifecycleReader({ identityUrl: config.identityInternalUrl, db, tasks, profiles }).run(
    stopping.signal
  )
} else {
  log(
    "warn",
    "IDENTITY_INTERNAL_URL is unset: not reading identity's lifecycle log, so a purged project's tasks and a deleted person's profile are kept, and a task's assignee can't be checked (503)"
  )
}
