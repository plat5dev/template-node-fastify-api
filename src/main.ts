import "dotenv/config"
import Fastify from "fastify"
import swagger from "@fastify/swagger"
import swaggerUi from "@fastify/swagger-ui"
import { createServer } from "node:http"
import { loadConfig } from "./config.js"
import { connect, migrate, type Db } from "./db.js"
import { collectMetrics, initMetrics, metricsContentType } from "./metrics.js"
import { registerObservability } from "./middleware/observability.js"
import { ProfilesStore } from "./profiles/store.js"
import { registerProfileRoutes } from "./profiles/routes.js"
import { ProjectsStore } from "./projects/store.js"
import { registerProjectRoutes } from "./projects/routes.js"
import { TasksStore } from "./tasks/store.js"
import { registerTaskRoutes } from "./tasks/routes.js"
import { initTelemetry } from "./telemetry.js"

const config = loadConfig()
const telemetry = initTelemetry(config)
initMetrics()

const db: Db = connect(config.databasePath)
migrate(db)

const profiles = new ProfilesStore(db)
const projects = new ProjectsStore(db)
const tasks = new TasksStore(db)

const app = Fastify({
  logger: false,
  // No CORS — gateway owns it (plat5 gateway-contract)
  trustProxy: true
})

registerObservability(app)

await app.register(swagger, {
  openapi: {
    info: {
      title: "Plat5 API",
      description: "Reference Node + Fastify business service for Plat5",
      version: config.serviceVersion
    }
  }
})
await app.register(swaggerUi, { routePrefix: "/docs" })

registerProfileRoutes(app, profiles)
registerProjectRoutes(app, projects)
registerTaskRoutes(app, tasks, projects)

const internal = createServer(async (req, res) => {
  const url = req.url?.split("?")[0] ?? "/"
  if (url === "/health/live" || url === "/health/ready") {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ status: "healthy" }))
    return
  }
  if (url === "/metrics") {
    try {
      const body = await collectMetrics()
      res.writeHead(200, { "content-type": metricsContentType() })
      res.end(body)
    } catch {
      res.writeHead(500, { "content-type": "text/plain" })
      res.end("metrics collection failed")
    }
    return
  }
  res.writeHead(404).end()
})

const shutdown = async (signal: string) => {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "info",
      message: "shutting down",
      signal
    })
  )
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
