import type { FastifyInstance, FastifyRequest } from "fastify"
import {
  context,
  propagation,
  type Span,
  SpanStatusCode,
  trace
} from "@opentelemetry/api"
import { ApiError } from "../errors.js"
import { observeRequest } from "../metrics.js"
import {
  MEMBERSHIP_ID_HEADER,
  ORGANIZATION_ID_HEADER,
  REQUEST_ID_HEADER,
  USER_ID_HEADER,
  readHeader,
  requestIdOf
} from "./identity.js"

const ULID_OR_UUID =
  /^(?:[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

/** Low-cardinality route label for metrics (plat5/docs/telemetry.md). */
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
}

const state = new WeakMap<FastifyRequest, ReqState>()

export const registerObservability = (app: FastifyInstance): void => {
  app.addHook("onRequest", async (req) => {
    const carrier: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") carrier[k] = v
      else if (Array.isArray(v) && v[0]) carrier[k] = v[0]
    }
    const parentCtx = propagation.extract(context.active(), carrier)
    const tracer = trace.getTracer("api")
    const route = req.routeOptions.url ?? normalizeRoute(req.url)
    const span = tracer.startSpan(
      `${req.method} ${route}`,
      {
        attributes: {
          "http.method": req.method,
          "http.route": route,
          "url.path": req.url.split("?")[0] ?? req.url
        }
      },
      parentCtx
    )
    state.set(req, { started: performance.now(), span })

    const requestId = readHeader(req, REQUEST_ID_HEADER)
    if (requestId) span.setAttribute("request_id", requestId)
    const userId = readHeader(req, USER_ID_HEADER)
    if (userId) span.setAttribute("user.id", userId)
    const organizationId = readHeader(req, ORGANIZATION_ID_HEADER)
    if (organizationId) span.setAttribute("organization.id", organizationId)
    const membershipId = readHeader(req, MEMBERSHIP_ID_HEADER)
    if (membershipId) span.setAttribute("membership.id", membershipId)
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

    if (s?.span) {
      s.span.setAttribute("http.status_code", status)
      if (status >= 500) {
        s.span.setAttribute("error.kind", "internal")
        s.span.setStatus({ code: SpanStatusCode.ERROR, message: "request failed" })
      }
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
    const userId = readHeader(req, USER_ID_HEADER)
    const organizationId = readHeader(req, ORGANIZATION_ID_HEADER)
    const membershipId = readHeader(req, MEMBERSHIP_ID_HEADER)
    if (userId) line.user_id = userId
    if (organizationId) line.organization_id = organizationId
    if (membershipId) line.membership_id = membershipId
    if (status >= 500) {
      line.error_kind = "internal"
      line.error_message = "request failed"
    }
    console.log(JSON.stringify(line))
  })

  app.setErrorHandler((err, req, reply) => {
    const requestId = requestIdOf(req)
    const s = state.get(req)

    if (err instanceof ApiError) {
      if (err.status >= 500 && s?.span) {
        s.span.setAttribute("error.kind", err.kind)
        s.span.setStatus({ code: SpanStatusCode.ERROR, message: err.message })
      }
      return reply.status(err.status).send(err.envelope(requestId))
    }

    // Handler Zod.parse (JSON Schema/AJV does not apply .trim())
    if (
      err &&
      typeof err === "object" &&
      "issues" in err &&
      Array.isArray((err as { issues: unknown }).issues)
    ) {
      const issues = (
        err as {
          issues: Array<{ path?: unknown[]; message?: string }>
        }
      ).issues
      const fields = issues.map((issue) => ({
        path: (issue.path ?? []).map(String).join(".") || "body",
        message: issue.message ?? "invalid"
      }))
      const apiErr = new ApiError({
        type: "invalid_request_error",
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        details: { fields },
        status: 422,
        kind: "validation"
      })
      return reply.status(422).send(apiErr.envelope(requestId))
    }

    if (err && typeof err === "object" && "validation" in err) {
      const validation = (
        err as { validation?: Array<{ instancePath?: string; message?: string }> }
      ).validation
      const fields =
        validation?.map((v) => ({
          path: (v.instancePath ?? "").replace(/^\//, "") || "body",
          message: v.message ?? "invalid"
        })) ?? []
      const apiErr = new ApiError({
        type: "invalid_request_error",
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        details: { fields },
        status: 422,
        kind: "validation"
      })
      return reply.status(422).send(apiErr.envelope(requestId))
    }

    if (s?.span) {
      s.span.setAttribute("error.kind", "internal")
      s.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : "request failed"
      })
    }

    const apiErr = new ApiError({
      type: "api_error",
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
      details: null,
      status: 500,
      kind: "internal"
    })
    return reply.status(500).send(apiErr.envelope(requestId))
  })
}
