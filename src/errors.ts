/** What failed, for a 5xx's `error_type` and `error.type` (plat5 docs/reference/telemetry.md#error-fields-5xx-only). */
export type ErrorKind = "auth" | "network" | "db" | "io" | "internal" | "validation"

/** A field and its sentence, in a 422's `details.fields`. */
export type Field = { path: string; message: string }

/** An error the API answers, in the Plat5 envelope (plat5 docs/reference/errors.md). */
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

// Each fallback sentence is plat5 docs/reference/error-copy.md's.

/** The 422 sentence when nothing more specific applies. */
export const FALLBACK_VALIDATION = "That doesn't look right."

/**
 * A 400: a request malformed before its values are read, such as a body not sent as JSON,
 * or a create without the `X-Plat5-Member-Id` the API requires of the front door.
 */
export const invalidRequest = (): ApiError =>
  new ApiError({
    type: "invalid_request_error",
    code: "INVALID_REQUEST",
    message: "Malformed request.",
    status: 400
  })

/** A 422 listing `fields`, the first one's sentence its message. */
export const validationError = (fields: Field[]): ApiError =>
  new ApiError({
    type: "invalid_request_error",
    code: "VALIDATION_ERROR",
    message: fields[0]?.message ?? FALLBACK_VALIDATION,
    details: { fields },
    status: 422,
    kind: "validation"
  })

/** A 422 for one field. No message is the fallback sentence. */
export const fieldError = (path: string, message = FALLBACK_VALIDATION): ApiError =>
  validationError([{ path, message }])

export const notFound = (resource: string, id: string | null): ApiError =>
  new ApiError({
    type: "invalid_request_error",
    code: "NOT_FOUND",
    message: "Resource not found.",
    details: { resource, id },
    status: 404
  })

/** A 500. Its message is always the fallback sentence: never a framework's or a library's. */
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
