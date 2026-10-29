/**
 * List parameters, the way every Plat5 list takes them (plat5 docs/reference/lists.md).
 *
 * `limit` defaults to 50; over 100 is clamped. `starting_after` is the id of the last item
 * on the previous page. Lists run in id order (ids are ULIDs, so oldest first) and answer
 * with the collection and `has_more`.
 */
import { Type } from "@sinclair/typebox"
import { isLowercaseUlid, trimSpace } from "./body.js"
import { fieldError } from "./errors.js"

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 100

/** Query schema for list routes, for the OpenAPI. Values are read by `parsePage`. */
export const listQuerySchema = Type.Object({
  limit: Type.Optional(
    Type.String({ description: "Default 50, max 100. Over the max is clamped." })
  ),
  starting_after: Type.Optional(
    Type.String({ description: "The id of the last item on the previous page." })
  )
})

/** One request's limit and cursor. An empty `startingAfter` is the first page. */
export type Page = { limit: number; startingAfter: string }

/** A query parameter's first value, or "" without one. */
const first = (value: unknown): string => {
  const v = Array.isArray(value) ? value[0] : value
  return typeof v === "string" ? v : ""
}

const INT64_MAX = 2n ** 63n - 1n

/**
 * A whole number in base 10 with an optional sign, as Go's strconv.Atoi reads it, or null
 * when it isn't one or doesn't fit in 64 bits.
 */
const atoi = (s: string): number | null => {
  if (!/^[+-]?\d+$/.test(s)) return null
  const n = BigInt(s)
  if (n > INT64_MAX || n < -INT64_MAX - 1n) return null
  return Number(n)
}

/**
 * Reads `limit` and `starting_after` (the first of each), white space trimmed. A limit
 * under 1 or not a whole number, or a cursor that isn't a lowercase ULID, is a 422; the
 * limit is checked first. A well-formed cursor that isn't in the list is not an error: the
 * walk continues after it in id order.
 */
export const parsePage = (query: unknown): Page => {
  const q = (typeof query === "object" && query !== null ? query : {}) as Record<
    string,
    unknown
  >
  let limit = DEFAULT_LIMIT
  const rawLimit = trimSpace(first(q.limit))
  if (rawLimit !== "") {
    const n = atoi(rawLimit)
    if (n === null || n < 1) throw fieldError("limit")
    limit = Math.min(n, MAX_LIMIT)
  }
  const startingAfter = trimSpace(first(q.starting_after))
  if (startingAfter !== "" && !isLowercaseUlid(startingAfter)) {
    throw fieldError("starting_after")
  }
  return { limit, startingAfter }
}

/** Cuts rows fetched with `limit + 1` down to the page, and says whether another exists. */
export const trim = <T>(rows: T[], page: Page): { items: T[]; hasMore: boolean } =>
  rows.length > page.limit
    ? { items: rows.slice(0, page.limit), hasMore: true }
    : { items: rows, hasMore: false }
