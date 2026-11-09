/**
 * Each request's server span, metrics and log line (plat5 docs/reference/telemetry.md).
 *
 * The span starts once the route is matched: named `{method} {route}`, or `{method}` on no
 * route, its parent the request's `traceparent`. When the response is sent the span ends,
 * marked failed on a 5xx only, and the request is counted and logged as one JSON line, with
 * the ids the front door gave.
 */
import {
  type Context,
  propagation,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace
} from "@opentelemetry/api"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { ApiError } from "./errors.ts"
import { observeRequest } from "./metrics.ts"
import { redactQuery } from "./redact.ts"

declare module "fastify" {
  interface FastifyRequest {
    /** The request's server span. */
    span: Span | null
    /** The error the request was answered with, and what caused it when it wasn't the API's own. */
    failure: { answer: ApiError; cause: unknown } | null
  }
}

/** A request header as sent, or undefined without one. */
export const headerOf = (req: FastifyRequest, name: string): string | undefined => {
  const value = req.headers[name]
  return typeof value === "string" && value !== "" ? value : undefined
}

/** The request's `X-Request-ID`, from the front door, or null without one. */
export const requestIdOf = (req: FastifyRequest): string | null =>
  headerOf(req, "x-request-id") ?? null

const CALLER_HEADERS = [
  ["node_id", "x-plat5-project-id"],
  ["member_id", "x-plat5-member-id"],
  ["user_id", "x-plat5-user-id"]
] as const

/**
 * The ids the front door gave this request (plat5 docs/reference/headers.md): the project
 * node and the caller's member on a project route, the user on a user route. Log fields use
 * them as named; span attributes add the `plat5.` prefix.
 */
const callerIds = (req: FastifyRequest): [field: string, value: string][] => {
  const ids: [string, string][] = []
  for (const [field, header] of CALLER_HEADERS) {
    const value = headerOf(req, header)
    if (value !== undefined) ids.push([field, value])
  }
  return ids
}

/** The request's span as a trace context: the parent of a downstream call, which sends it as `traceparent`. */
export const traceContextOf = (req: FastifyRequest): Context =>
  req.span ? trace.setSpan(ROOT_CONTEXT, req.span) : ROOT_CONTEXT

/** The scheme of the request this server received: its connection's, never a header's. */
const schemeOf = (req: FastifyRequest): string =>
  (req.raw.socket as { encrypted?: boolean }).encrypted ? "https" : "http"

export const registerObservability = (app: FastifyInstance): void => {
  app.decorateRequest("span", null)
  app.decorateRequest("failure", null)

  app.addHook("onRequest", async (req) => {
    const parent = propagation.extract(ROOT_CONTEXT, req.headers)
    const route = req.routeOptions.url
    const at = req.url.indexOf("?")
    const query = at >= 0 ? req.url.slice(at + 1) : ""
    req.span = trace.getTracer("api").startSpan(
      route ? `${req.method} ${route}` : req.method,
      {
        kind: SpanKind.SERVER,
        attributes: {
          "http.request.method": req.method,
          "url.path": at >= 0 ? req.url.slice(0, at) : req.url,
          "url.scheme": schemeOf(req),
          ...(query !== "" ? { "url.query": redactQuery(query) } : {}),
          ...(route ? { "http.route": route } : {})
        }
      },
      parent
    )
    const requestId = requestIdOf(req)
    if (requestId) req.span.setAttribute("request_id", requestId)
  })

  app.addHook("onResponse", async (req, reply) => {
    const status = reply.statusCode
    const route = req.routeOptions.url ?? "unknown"
    // To the microsecond.
    const durationMs = Math.round(reply.elapsedTime * 1000) / 1000
    observeRequest(req.method, route, status, durationMs / 1000)

    const ids = callerIds(req)
    const errorType = req.failure?.answer.kind ?? "internal"
    const span = req.span
    if (span) {
      span.setAttribute("http.response.status_code", status)
      for (const [field, value] of ids) span.setAttribute(`plat5.${field}`, value)
      if (status >= 500) {
        span.setAttribute("error.type", errorType)
        span.setStatus({ code: SpanStatusCode.ERROR })
      }
      span.end()
    }

    const line: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
      message: "request completed",
      route,
      method: req.method,
      status,
      duration_ms: durationMs
    }
    const requestId = requestIdOf(req)
    if (requestId) line.request_id = requestId
    for (const [field, value] of ids) line[field] = value
    if (status >= 500) {
      line.error_type = errorType
      const { answer, cause } = req.failure ?? {}
      line.error_message =
        cause instanceof Error
          ? cause.message
          : answer
            ? `${answer.code}: ${answer.message}`
            : "request failed"
    }
    const sc = span?.spanContext()
    if (sc && trace.isSpanContextValid(sc)) {
      line.trace_id = sc.traceId
      line.span_id = sc.spanId
    }
    console.log(JSON.stringify(line))
  })
}
