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

export const validationError = (
  message = "Request validation failed",
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

export const notFound = (resource: string, id: string): ApiError =>
  new ApiError({
    type: "invalid_request_error",
    code: "NOT_FOUND",
    message: "Resource not found",
    details: { resource, id },
    status: 404
  })

export const conflict = (field: string, value: string): ApiError =>
  new ApiError({
    type: "invalid_request_error",
    code: "CONFLICT",
    message: "Resource already exists",
    details: { field, value },
    status: 409
  })

export const internalError = (
  message = "An unexpected error occurred"
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
    message: "Service temporarily unavailable",
    details: null,
    status: 503,
    kind: "network"
  })
