/**
 * Reads a request's JSON body: a body sent as JSON, or a 422 at `body`.
 *
 * A body counts as JSON only with Content-Type `application/json` (any parameters, such as
 * charset) or an `application/…+json` type. Without a Content-Type, or with any other, the
 * body is a 422 at `body` whatever it holds, empty included: a client that forgot the
 * header never gets a write that silently changed nothing. Bind failures use the fallback
 * sentence (plat5 docs/reference/error-copy.md).
 *
 * The app keeps every body as raw bytes (see app.ts), so a route that doesn't read its body,
 * such as DELETE, takes any body, and the Content-Type the client sent is kept here.
 */
import type { FastifyRequest } from "fastify"
import { fieldError } from "./errors.js"

const contentTypes = new WeakMap<object, string>()

/** Keeps the Content-Type the client sent, before the app swaps it for its raw parser. */
export const keepContentType = (req: FastifyRequest, value: string): void => {
  contentTypes.set(req.raw, value)
}

/** The Content-Type the client sent, or undefined without one. */
export const contentTypeOf = (req: FastifyRequest): string | undefined =>
  contentTypes.get(req.raw)

// Go's unicode.IsSpace.
const SPACE = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000"
const LEADING_SPACE = new RegExp(`^[${SPACE}]+`)
const TRAILING_SPACE = new RegExp(`[${SPACE}]+$`)

/**
 * `s` without leading and trailing white space, as Go's strings.TrimSpace: Unicode white
 * space, which isn't quite JavaScript's trim (U+0085 is space, U+FEFF isn't).
 */
export const trimSpace = (s: string): string => s.replace(LEADING_SPACE, "").replace(TRAILING_SPACE, "")

/** `s`'s length in characters (Unicode code points), not UTF-16 units. */
export const charLength = (s: string): number => {
  let n = 0
  for (const _ of s) n++
  return n
}

/** Whether `contentType` names JSON: application/json or application/…+json, any parameters. */
export const isJson = (contentType: string | undefined): boolean => {
  if (contentType === undefined) return false
  const type = trimSpace(contentType.split(";")[0]!).toLowerCase()
  return (
    type === "application/json" || (type.startsWith("application/") && type.endsWith("+json"))
  )
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/** `s` with each unpaired surrogate replaced by U+FFFD, as Go's decoder does. */
const wellFormed = (s: string): string => s.replace(LONE_SURROGATE, "\uFFFD")

/** A body's field: its JSON value, or undefined when the body hasn't it. */
export type Fields = Record<string, unknown>

// Go matches a JSON key to a field ignoring case, with Unicode simple folding.
const fold = (key: string): string => key.toLowerCase().replace(/ſ/g, "s")

/**
 * The request's body as `names`' values. A body not sent as JSON, an empty body, or one
 * that isn't a JSON object (malformed, trailing data, an array) is a 422 at `body`. A JSON
 * null is an empty object. Keys match ignoring case, the last one winning; others are
 * ignored. A string has its unpaired surrogates replaced, as Go decodes them.
 */
export const readBody = (req: FastifyRequest, names: readonly string[]): Fields => {
  if (!isJson(contentTypeOf(req))) throw fieldError("body")
  const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : ""
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw fieldError("body")
  }
  if (parsed === null) return {}
  if (typeof parsed !== "object" || Array.isArray(parsed)) throw fieldError("body")
  const out: Fields = {}
  for (const [key, value] of Object.entries(parsed)) {
    const name = names.includes(key) ? key : names.find((n) => n === fold(key))
    if (name !== undefined) out[name] = typeof value === "string" ? wellFormed(value) : value
  }
  return out
}

/**
 * A field that must be a string when it's set: the string, or undefined when absent or
 * null. Any other JSON type is a 422 at `body`, as Go's decoder answers it.
 */
export const optionalString = (fields: Fields, name: string): string | undefined => {
  const value = fields[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") throw fieldError("body")
  return value
}

/** A lowercase ULID: a Plat5 id, and this API's (Go's ulid.ParseStrict, lowercase). */
export const isLowercaseUlid = (id: string): boolean => /^[0-7][0-9a-hjkmnp-tv-z]{25}$/.test(id)
