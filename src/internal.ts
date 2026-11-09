import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { Db } from "./db.ts"
import { notFound } from "./errors.ts"

const JSON_TYPE = "application/json; charset=utf-8"

/** What answers `/metrics`: the Prometheus text of every series. */
export type MetricsHandler = (req: IncomingMessage, res: ServerResponse) => void

/**
 * The internal port: liveness, readiness (the database answers), and the Prometheus scrape.
 * GET (and HEAD) only; anything else is the 404 envelope. Not traced.
 */
export const createInternalServer = (db: Db, metrics: MetricsHandler): Server =>
  createServer((req, res) => {
    const send = (status: number, body: string) => {
      res.writeHead(status, {
        "content-type": JSON_TYPE,
        "content-length": Buffer.byteLength(body)
      })
      res.end(body)
    }
    const path = req.url?.split("?")[0]
    if (req.method === "GET" || req.method === "HEAD") {
      if (path === "/health/live") return send(200, `{"status":"healthy"}`)
      if (path === "/health/ready") {
        try {
          db.prepare("SELECT 1").get()
          return send(200, `{"status":"healthy"}`)
        } catch {
          return send(503, `{"status":"unhealthy"}`)
        }
      }
      if (path === "/metrics") return metrics(req, res)
    }
    const requestId = req.headers["x-request-id"]
    send(
      404,
      JSON.stringify(
        notFound("resource", null).envelope(
          typeof requestId === "string" && requestId !== "" ? requestId : null
        )
      )
    )
  })
