import type { FastifyRequest } from "fastify"
import {
  context,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace
} from "@opentelemetry/api"
import {
  ApiError,
  FALLBACK_VALIDATION,
  fieldError,
  notFound,
  payloadTooLarge
} from "../errors.js"
import { observeRequest } from "../metrics.js"
import type { App } from "../types.js"

const REQUEST_ID_HEADER = "x-request-id"

const readHeader = (req: FastifyRequest, name: string): string | undefined => {
  const value = req.headers[name]
  if (typeof value === "string" && value.trim() !== "") return value
  if (Array.isArray(value) && value[0] && value[0].trim() !== "") return value[0]
  return undefined
}

const requestIdOf = (req: FastifyRequest): string | null =>
  readHeader(req, REQUEST_ID_HEADER) ?? null

/** Path param on the matched route, when that route has it. */
const pathParam = (req: FastifyRequest, name: string): string | undefined => {
  const params = req.params
  if (typeof params !== "object" || params === null) return undefined
  const value = (params as Record<string, unknown>)[name]
  return typeof value === "string" && value !== "" ? value : undefined
}

/**
 * The ids the front door gave this request (plat5 docs/reference/telemetry.md): the user on
 * a user route, the project node and the caller's member on a project route. Log fields use
 * them as named; span attributes add the `plat5.` prefix.
 */
const callerIds = (req: FastifyRequest): [field: string, value: string][] => {
  const ids: [string, string][] = []
  const userId = pathParam(req, "user_id")
  if (userId) ids.push(["user_id", userId])
  const projectId = pathParam(req, "project_id")
  if (projectId) ids.push(["node_id", projectId])
  const memberId = readHeader(req, "x-plat5-member-id")
  if (memberId) ids.push(["member_id", memberId])
  return ids
}

const ULID_OR_UUID =
  /^(?:[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

/** Low-cardinality route label for metrics (plat5 docs/reference/telemetry.md). */
export const normalizeRoute = (path: string): string => {
  const bare = path.split("?")[0] || "/"
  const parts = bare.split("/").map((seg) => {
    if (seg === "") return seg
    if (ULID_OR_UUID.test(seg)) return "{id}"
    if (/^\d+$/.test(seg)) return "{id}"
    return seg
  })
  const joined = parts.join("/")
  return joined.length > 80 ? joined.slice(0, 80) : joined
}

type ReqState = {
  started: number
  span: Span
  errorKind?: string
}

const state = new WeakMap<FastifyRequest, ReqState>()

const pathOf = (url: string): string => url.split("?")[0] ?? url

const stampTrace = (
  line: Record<string, unknown>,
  span: Span | undefined
): void => {
  if (!span) return
  const sc = span.spanContext()
  if (!trace.isSpanContextValid(sc)) return
  line.trace_id = sc.traceId
  line.span_id = sc.spanId
}

const applyHttpStatus = (span: Span, status: number, errorKind?: string): void => {
  span.setAttribute("http.response.status_code", status)
  if (status < 500) return
  span.setAttribute("error.kind", errorKind ?? "internal")
  span.setStatus({ code: SpanStatusCode.ERROR })
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

    const requestId = readHeader(req, REQUEST_ID_HEADER)
    if (requestId) span.setAttribute("request_id", requestId)
  })

  app.addHook("onResponse", async (req, reply) => {
    const s = state.get(req)
    const started = s?.started ?? performance.now()
    const durationMs = Math.round((performance.now() - started) * 100) / 100
    const durationSeconds = durationMs / 1000
    const status = reply.statusCode
    const route =
      req.routeOptions.url ?? normalizeRoute(req.url.split("?")[0] ?? req.url)
    const path = req.url.split("?")[0] ?? req.url

    observeRequest(req.method, route, status, durationSeconds)

    const ids = callerIds(req)

    if (s?.span) {
      const template = req.routeOptions.url
      if (template) {
        s.span.updateName(`${req.method} ${template}`)
        s.span.setAttribute("http.route", template)
      }
      for (const [field, value] of ids) s.span.setAttribute(`plat5.${field}`, value)
      applyHttpStatus(s.span, status, s.errorKind)
      s.span.end()
    }

    const line: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level: status >= 500 ? "error" : "info",
      message: "request completed",
      route: path,
      method: req.method,
      status,
      duration_ms: durationMs,
      request_id: requestIdOf(req)
    }
    for (const [field, value] of ids) line[field] = value
    if (status >= 500) {
      line.error_kind = "internal"
      line.error_message = "request failed"
    }
    stampTrace(line, s?.span)
    console.log(JSON.stringify(line))
  })

  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send(notFound("resource", null).envelope(requestIdOf(req)))
  )

  app.setErrorHandler((err, req, reply) => {
    const requestId = requestIdOf(req)
    const s = state.get(req)

    if (err instanceof ApiError) {
      if (err.status >= 500 && s) {
        s.errorKind = err.kind
        applyHttpStatus(s.span, err.status, err.kind)
      }
      return reply.status(err.status).send(err.envelope(requestId))
    }

    // Fastify request validation (JSON Schema/AJV) failures. AJV's own text is
    // schema talk, not product copy (plat5 docs/reference/error-copy.md): name the
    // field, in a sentence.
    if (err && typeof err === "object" && "validation" in err) {
      const validation = (err as { validation?: AjvIssue[] }).validation ?? []
      // A union (anyOf of consts) fails once per branch: one field each.
      const fields = validation
        .map(ajvField)
        .filter((f, i, all) => all.findIndex((g) => g.path === f.path) === i)
      const apiErr = new ApiError({
        type: "invalid_request_error",
        code: "VALIDATION_ERROR",
        message: fields[0]?.message ?? FALLBACK_VALIDATION,
        details: { fields },
        status: 422,
        kind: "validation"
      })
      return reply.status(422).send(apiErr.envelope(requestId))
    }

    // Fastify's own client errors: a body that isn't JSON, or one over bodyLimit. Their
    // text isn't product copy either: the envelope, with a fallback sentence.
    const statusCode = (err as { statusCode?: number }).statusCode
    if (statusCode === 400) {
      return reply.status(422).send(fieldError("body").envelope(requestId))
    }
    if (statusCode === 413) {
      const apiErr = payloadTooLarge(req.server.initialConfig.bodyLimit ?? 0)
      return reply.status(413).send(apiErr.envelope(requestId))
    }

    if (s) {
      s.errorKind = "internal"
      applyHttpStatus(s.span, 500, "internal")
    }

    const apiErr = new ApiError({
      type: "api_error",
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred.",
      details: null,
      status: 500,
      kind: "internal"
    })
    return reply.status(500).send(apiErr.envelope(requestId))
  })
}

type AjvIssue = {
  instancePath?: string
  keyword?: string
  params?: { missingProperty?: string; limit?: number; allowedValues?: unknown[] }
}

/** One AJV issue as a field and a sentence. */
const ajvField = (v: AjvIssue): { path: string; message: string } => {
  const base = (v.instancePath ?? "").replace(/^\//, "").replace(/\//g, ".")
  const missing = v.keyword === "required" ? v.params?.missingProperty : undefined
  const path = missing ? (base ? `${base}.${missing}` : missing) : base || "body"
  const field = path.split(".").pop() ?? path
  const label = `${field.charAt(0).toUpperCase()}${field.slice(1).replace(/_/g, " ")}`
  switch (v.keyword) {
    case "required":
      return { path, message: `${label} is required.` }
    case "maxLength":
      return { path, message: `${label} is too long.` }
    case "minLength":
      return { path, message: `${label} is required.` }
    case "enum":
    case "const":
    case "anyOf":
      return { path, message: `${label} isn't an allowed value.` }
    default:
      return { path, message: FALLBACK_VALIDATION }
  }
}
