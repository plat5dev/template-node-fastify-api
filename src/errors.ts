export type ErrorKind =
  | "auth"
  | "network"
  | "db"
  | "io"
  | "internal"
  | "validation"

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

// Common errors. Each fallback sentence is plat5 docs/reference/error-copy.md's.

/** The 422 sentence when nothing more specific applies. */
export const FALLBACK_VALIDATION = "That doesn't look right."

/**
 * A 400: the request lacks something the API requires of the front door, such as
 * `X-Plat5-Member-Id` on a create.
 */
export const invalidRequest = (): ApiError =>
  new ApiError({
    type: "invalid_request_error",
    code: "INVALID_REQUEST",
    message: "Malformed request.",
    details: null,
    status: 400
  })

export const validationError = (
  message = FALLBACK_VALIDATION,
  details: unknown = null
): ApiError =>
  new ApiError({
    type: "invalid_request_error",
    code: "VALIDATION_ERROR",
    message,
    details,
    status: 422,
    kind: "validation"
  })

/** A 422 for one field. No message is the fallback sentence. */
export const fieldError = (
  path: string,
  message = FALLBACK_VALIDATION
): ApiError => validationError(message, { fields: [{ path, message }] })

export const notFound = (resource: string, id: string | null): ApiError =>
  new ApiError({
    type: "invalid_request_error",
    code: "NOT_FOUND",
    message: "Resource not found.",
    details: { resource, id },
    status: 404
  })

export const conflict = (field: string, value: string): ApiError =>
  new ApiError({
    type: "invalid_request_error",
    code: "CONFLICT",
    message: "That already exists.",
    details: { field, value },
    status: 409
  })

export const payloadTooLarge = (maxSizeBytes: number): ApiError =>
  new ApiError({
    type: "invalid_request_error",
    code: "PAYLOAD_TOO_LARGE",
    message: "Request body is too large.",
    details: { max_size_bytes: maxSizeBytes },
    status: 413
  })

export const internalError = (
  message = "An unexpected error occurred."
): ApiError =>
  new ApiError({
    type: "api_error",
    code: "INTERNAL_ERROR",
    message,
    details: null,
    status: 500,
    kind: "internal"
  })

export const serviceUnavailable = (): ApiError =>
  new ApiError({
    type: "api_error",
    code: "SERVICE_UNAVAILABLE",
    message: "Service temporarily unavailable.",
    details: null,
    status: 503,
    kind: "network"
  })
