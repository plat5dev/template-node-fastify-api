/**
 * List parameters, the way every Plat5 list takes them (plat5 docs/lists.md).
 *
 * `limit` defaults to 50; over 100 is clamped. `starting_after` is the id of the last item
 * on the previous page. Lists run in id order (ids are ULIDs, so oldest first) and answer
 * with the collection and `has_more`.
 */
import { Type } from "@sinclair/typebox"
import { isValid } from "ulid"
import { fieldError } from "./errors.js"

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 100

/** Query schema for list routes. Values are parsed by `parsePage`. */
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

/**
 * Reads `limit` and `starting_after`. A limit under 1 or not a whole number, or a cursor
 * that isn't a ULID, is a 422. A well-formed cursor that isn't in the list is not an error:
 * the walk continues after it in id order.
 */
export const parsePage = (query: {
  limit?: string
  starting_after?: string
}): Page => {
  let limit = DEFAULT_LIMIT
  const rawLimit = query.limit?.trim()
  if (rawLimit) {
    if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1) throw fieldError("limit")
    limit = Math.min(Number(rawLimit), MAX_LIMIT)
  }
  const startingAfter = query.starting_after?.trim() ?? ""
  if (startingAfter && !isValid(startingAfter)) throw fieldError("starting_after")
  return { limit, startingAfter }
}

/** Cuts rows fetched with `limit + 1` down to the page, and says whether another exists. */
export const trim = <T>(rows: T[], page: Page): { items: T[]; hasMore: boolean } =>
  rows.length > page.limit
    ? { items: rows.slice(0, page.limit), hasMore: true }
    : { items: rows, hasMore: false }
