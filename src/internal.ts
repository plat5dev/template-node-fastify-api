import { createServer, type IncomingMessage, type Server } from "node:http"
import type { Db } from "./db.js"
import { notFound } from "./errors.js"
import { collectMetrics, metricsContentType } from "./metrics.js"

const JSON_TYPE = "application/json; charset=utf-8"

const requestIdOf = (req: IncomingMessage): string | null => {
  const value = req.headersDistinct["x-request-id"]?.[0]
  return value ? value : null
}

/** How long the readiness check waits for the database. */
const READY_TIMEOUT_MS = 2_000

/**
 * The internal port: liveness, readiness (the database answers), and the Prometheus
 * scrape. GET (and HEAD) only; anything else is the 404 envelope.
 */
export const createInternalServer = (db: Db): Server =>
  createServer(async (req, res) => {
    const path = req.url?.split("?")[0] ?? "/"
    const method = req.method ?? "GET"
    const send = (status: number, contentType: string, body: string) => {
      res.writeHead(status, {
        "content-type": contentType,
        "content-length": Buffer.byteLength(body)
      })
      res.end(method === "HEAD" ? undefined : body)
    }
    if (method === "GET" || method === "HEAD") {
      if (path === "/health/live") return send(200, JSON_TYPE, `{"status":"healthy"}`)
      if (path === "/health/ready") {
        const started = performance.now()
        try {
          db.prepare("SELECT 1").get()
          if (performance.now() - started > READY_TIMEOUT_MS) throw new Error("slow")
          return send(200, JSON_TYPE, `{"status":"healthy"}`)
        } catch {
          return send(503, JSON_TYPE, `{"status":"unhealthy"}`)
        }
      }
      if (path === "/metrics") {
        try {
          return send(200, metricsContentType(), await collectMetrics())
        } catch {
          return send(500, "text/plain; charset=utf-8", "metrics collection failed")
        }
      }
    }
    send(404, JSON_TYPE, JSON.stringify(notFound("resource", null).envelope(requestIdOf(req))))
  })
