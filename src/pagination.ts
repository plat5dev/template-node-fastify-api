/**
 * List parameters, the way every Plat5 list takes them (plat5 docs/reference/lists.md).
 *
 * `limit` defaults to 50; over 100 is clamped; under 1 or not a whole number is a 422.
 * `starting_after` is the id of the last item on the previous page: a lowercase ULID, else a
 * 422. Lists run in id order (ids are ULIDs, so oldest first) and answer with the collection
 * and `has_more`.
 */
import { type Static, Type } from "typebox"
import { LOWERCASE_ULID } from "./schemas.ts"

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 100

/** The query of a list route. Query values are strings: a whole number is digits, not all zeros. */
export const listQuerySchema = Type.Object({
  limit: Type.Optional(
    Type.String({
      pattern: "^[0-9]*[1-9][0-9]*$",
      description: `A whole number: default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT} (more is ${MAX_LIMIT}).`
    })
  ),
  starting_after: Type.Optional(
    Type.String({
      pattern: LOWERCASE_ULID,
      description: "The id of the last item on the previous page."
    })
  )
})

/** One request's limit and cursor. An empty `startingAfter` is the first page. */
export type Page = { limit: number; startingAfter: string }

/** The page `query` asks for, the limit clamped. A cursor not in the list isn't an error: the walk continues after it. */
export const pageOf = (query: Static<typeof listQuerySchema>): Page => ({
  limit: Math.min(query.limit === undefined ? DEFAULT_LIMIT : Number(query.limit), MAX_LIMIT),
  startingAfter: query.starting_after ?? ""
})

/** Cuts rows fetched with `limit + 1` down to the page, and says whether another exists. */
export const trim = <T>(rows: T[], page: Page): { items: T[]; hasMore: boolean } =>
  rows.length > page.limit
    ? { items: rows.slice(0, page.limit), hasMore: true }
    : { items: rows, hasMore: false }
