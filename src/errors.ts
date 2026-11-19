import type { FastifySchemaValidationError } from "fastify"

export type ErrorKind = "network" | "db" | "internal" | "validation"

export type FieldError = { path: string; message: string }

/** An API error formatted in the Plat5 error envelope (plat5 docs/reference/errors.md). */
export class ApiError extends Error {
  readonly type: string
  readonly code: string
  readonly details: unknown
  readonly status: number
  readonly kind: ErrorKind

  constructor(opts: {
    type: string
    code: string
    message: string
    details?: unknown
    status: number
    kind?: ErrorKind
  }) {
    super(opts.message)
    this.name = "ApiError"
    this.type = opts.type
    this.code = opts.code
    this.details = opts.details ?? null
    this.status = opts.status
    this.kind = opts.kind ?? "internal"
  }

  envelope(requestId: string | null) {
    return {
      error: {
        type: this.type,
        code: this.code,
        message: this.message,
        request_id: requestId,
        details: this.details
      }
    }
  }
}

export const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

export const invalidRequest = (): ApiError =>
  new ApiError({
    type: "invalid_request_error",
    code: "INVALID_REQUEST",
    message: "Malformed request.",
    status: 400
  })

export const validationError = (fields: FieldError[]): ApiError =>
  new ApiError({
    type: "invalid_request_error",
    code: "VALIDATION_ERROR",
    message: fields[0]?.message ?? "Validation failed.",
    details: { fields },
    status: 422,
    kind: "validation"
  })

export const fieldError = (path: string, message: string): ApiError =>
  validationError([{ path, message }])

export const notFound = (resource: string, id: string | null): ApiError =>
  new ApiError({
    type: "invalid_request_error",
    code: "NOT_FOUND",
    message: "Resource not found.",
    details: { resource, id },
    status: 404
  })

export const internalError = (): ApiError =>
  new ApiError({
    type: "api_error",
    code: "INTERNAL_ERROR",
    message: "An unexpected error occurred.",
    status: 500
  })

export const serviceUnavailable = (): ApiError =>
  new ApiError({
    type: "api_error",
    code: "SERVICE_UNAVAILABLE",
    message: "Service temporarily unavailable.",
    status: 503,
    kind: "network"
  })

/** Converts an AJV JSON pointer (`/tags/0/name`) into a dotted/indexed field path (`tags[0].name`). */
const fieldPath = (pointer: string, key?: string): string => {
  const base = pointer
    .split("/")
    .slice(1)
    .map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((out, s) => (/^\d+$/.test(s) ? `${out}[${s}]` : out === "" ? s : `${out}.${s}`), "")
  return key === undefined ? base : base === "" ? key : `${base}.${key}`
}

/** Maps Fastify/AJV validation errors into a Plat5 422 VALIDATION_ERROR. */
export const validationFailed = (
  errors: readonly FastifySchemaValidationError[],
  part?: string
): ApiError => {
  const seen = new Set<string>()
  const fields: FieldError[] = []

  for (const e of errors) {
    const params = e.params as { additionalProperty?: string; missingProperty?: string }
    const key = params.additionalProperty ?? params.missingProperty
    const path = fieldPath(e.instancePath, key) || part || "body"
    if (seen.has(path)) continue
    seen.add(path)

    const message =
      e.keyword === "additionalProperties" && params.additionalProperty !== undefined
        ? `must NOT have additional property '${params.additionalProperty}'`
        : (e.message ?? "Invalid value.")
    fields.push({ path, message })
  }

  return validationError(fields)
}
