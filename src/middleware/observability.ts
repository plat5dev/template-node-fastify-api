import type { FastifyReply, FastifyRequest } from "fastify"
import {
  context,
  type Context,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace
} from "@opentelemetry/api"
import { keepContentType } from "../body.js"
import {
  ApiError,
  conflict,
  fieldError,
  internalError,
  MAX_BODY_BYTES,
  notFound,
  payloadTooLarge,
  serviceUnavailable
} from "../errors.js"
import { observeRequest } from "../metrics.js"
import type { App } from "../types.js"

const REQUEST_ID_HEADER = "x-request-id"

/** A request header's first value, as sent, or "" without one. */
export const headerOf = (req: FastifyRequest, name: string): string => {
  const distinct = (req.raw as { headersDistinct?: Record<string, string[] | undefined> })
    .headersDistinct?.[name]
  if (Array.isArray(distinct) && distinct[0] !== undefined) return distinct[0]
  const value = req.headers[name]
  if (typeof value === "string") return value
  if (Array.isArray(value) && value[0] !== undefined) return value[0]
  return ""
}

/** The request's `X-Request-ID`, from the front door: as sent, or null without one. */
export const requestIdOf = (req: FastifyRequest): string | null =>
  headerOf(req, REQUEST_ID_HEADER) || null

/** Path param on the matched route, when that route has it. */
const pathParam = (req: FastifyRequest, name: string): string | undefined => {
  const params = req.params
  if (typeof params !== "object" || params === null) return undefined
  const value = (params as Record<string, unknown>)[name]
  return typeof value === "string" && value !== "" ? value : undefined
}

/**
 * The ids the front door gave this request (plat5 docs/reference/telemetry.md): the user on
 * a user route, the environment node and the caller's member on an environment route. Log
 * fields use them as named; span attributes add the `plat5.` prefix.
 */
const callerIds = (req: FastifyRequest): [field: string, value: string][] => {
  const ids: [string, string][] = []
  const userId = pathParam(req, "user_id")
  if (userId) ids.push(["user_id", userId])
  const environmentId = pathParam(req, "environment_id")
  if (environmentId) ids.push(["node_id", environmentId])
  const memberId = headerOf(req, "x-plat5-member-id")
  if (memberId) ids.push(["member_id", memberId])
  return ids
}

type ReqState = {
  started: number
  span: Span
  /** The error the request was answered with, if any. */
  error?: ApiError
}

const state = new WeakMap<FastifyRequest, ReqState>()

/**
 * The request's server span as a trace context: the parent of a downstream call, which
 * sends it as `traceparent` with `propagation.inject`.
 */
export const traceContextOf = (req: FastifyRequest): Context => {
  const span = state.get(req)?.span
  return span ? trace.setSpan(context.active(), span) : context.active()
}

const pathOf = (url: string): string => url.split("?")[0] ?? url

const stampTrace = (line: Record<string, unknown>, span: Span | undefined): void => {
  if (!span) return
  const sc = span.spanContext()
  if (!trace.isSpanContextValid(sc)) return
  line.trace_id = sc.traceId
  line.span_id = sc.spanId
}

const applyHttpStatus = (span: Span, status: number, errorKind: string): void => {
  span.setAttribute("http.response.status_code", status)
  if (status < 500) return
  span.setAttribute("error.kind", errorKind)
  span.setStatus({ code: SpanStatusCode.ERROR })
}

/**
 * Any error as the API's: its own as they are, a framework's by its status, and anything
 * else the fallback 500. Never a framework's text in the message (plat5
 * docs/reference/errors.md).
 */
const toApiError = (err: unknown): ApiError => {
  if (err instanceof ApiError) return err
  const statusCode =
    typeof err === "object" && err !== null
      ? (err as { statusCode?: unknown }).statusCode
      : undefined
  switch (statusCode) {
    case 400:
      return fieldError("body")
    case 404:
    case 405:
      return notFound("resource", null)
    case 409:
      return conflict("", null)
    case 413:
      return payloadTooLarge()
    case 503:
      return serviceUnavailable()
    default:
      // A 401 too: authentication is the gateway's, so this service never answers one.
      return internalError()
  }
}

/** Answers `err` in the Plat5 envelope. Also the app's handler for Fastify's own errors. */
export const sendError = (err: unknown, req: FastifyRequest, reply: FastifyReply): void => {
  const apiErr = toApiError(err)
  const s = state.get(req)
  if (s) s.error = apiErr
  // Never a 405 (errors.md has no such code), so no Allow header either.
  reply.removeHeader("allow")
  void reply.status(apiErr.status).send(apiErr.envelope(requestIdOf(req)))
}

export const registerObservability = (app: App): void => {
  app.addHook("onRequest", async (req) => {
    const carrier: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") carrier[k] = v
      else if (Array.isArray(v) && v[0]) carrier[k] = v[0]
    }
    const parentCtx = propagation.extract(context.active(), carrier)
    const tracer = trace.getTracer("api")
    const path = pathOf(req.url)
    const template = req.routeOptions.url
    const spanName = template ? `${req.method} ${template}` : req.method
    const span = tracer.startSpan(
      spanName,
      {
        kind: SpanKind.SERVER,
        attributes: {
          "http.request.method": req.method,
          "url.path": path
        }
      },
      parentCtx
    )
    if (template) span.setAttribute("http.route", template)
    state.set(req, { started: performance.now(), span })

    const requestId = requestIdOf(req)
    if (requestId) span.setAttribute("request_id", requestId)

    // Every body is kept as raw bytes, whatever its Content-Type (app.ts), with the
    // Content-Type sent kept for the routes that read a body: one that doesn't, like
    // DELETE, takes any body, and one that does answers 422 at body, never 415.
    if (req.headers["content-type"] !== undefined) {
      keepContentType(req, headerOf(req, "content-type"))
      req.headers["content-type"] = "application/octet-stream"
    }
    // Too large is a 413 before anything else, on any route.
    const length = Number(req.headers["content-length"] ?? 0)
    if (length > MAX_BODY_BYTES) throw payloadTooLarge()
  })

  app.addHook("onResponse", async (req, reply) => {
    const s = state.get(req)
    const started = s?.started ?? performance.now()
    // To the microsecond.
    const durationMs = Math.floor((performance.now() - started) * 1000) / 1000
    const status = reply.statusCode
    const template = req.routeOptions.url
    const route = template || "unknown"

    observeRequest(req.method, route, status, durationMs / 1000)

    const ids = callerIds(req)
    const err = s?.error
    const errorKind = err?.kind ?? "internal"

    if (s?.span) {
      if (template) {
        s.span.updateName(`${req.method} ${template}`)
        s.span.setAttribute("http.route", template)
      }
      for (const [field, value] of ids) s.span.setAttribute(`plat5.${field}`, value)
      applyHttpStatus(s.span, status, errorKind)
      s.span.end()
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
      line.error_kind = errorKind
      line.error_message = err ? `${err.code}: ${err.message}` : "request failed"
    }
    stampTrace(line, s?.span)
    console.log(JSON.stringify(line))
  })

  // An unknown route, or a known path in a method it doesn't serve (OPTIONS included): the
  // same 404 either way, never a 405.
  app.setNotFoundHandler((req, reply) => sendError(notFound("resource", null), req, reply))

  app.setErrorHandler((err, req, reply) => sendError(err, req, reply))
}
