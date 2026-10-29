/**
 * What a write changed, for Plat5's audit log (plat5 docs/concepts/audit.md#what-a-service-adds).
 *
 * The gateway records every audited request before it reaches this service. A write adds
 * what it changed on `X-Plat5-Audit-Details`, and a create names the id it made on
 * `X-Plat5-Audit-Created`. The gateway stores both with the event and strips them before
 * the response reaches the client.
 *
 * Changes are `{ from, to }` for the fields that changed. A create names what it made.
 * A delete sends nothing: the route and its path say what happened. Never a secret.
 */
import { trace } from "@opentelemetry/api"
import type { FastifyReply } from "fastify"
import { traceContextOf } from "./middleware/observability.js"

export const DETAILS_HEADER = "X-Plat5-Audit-Details"
export const CREATED_HEADER = "X-Plat5-Audit-Created"
/** The gateway's cap. Over it, the gateway would drop the details. */
export const MAX_BYTES = 4096

/** One write's change. */
export type Details = Record<string, unknown>

/** Records `field` when `from` and `to` differ. */
export const changed = (
  details: Details,
  field: string,
  from: unknown,
  to: unknown
): void => {
  if (from !== to) details[field] = { from, to }
}

/**
 * `details` as one JSON object of visible ASCII, or null over the cap. Keys are sorted;
 * `<`, `>` and `&` and all non-ASCII are escaped as \u (astral characters as surrogate
 * pairs), which is still the same JSON.
 */
export const encode = (details: Details): string | null => {
  const sorted: Details = {}
  for (const key of Object.keys(details).sort()) sorted[key] = details[key]
  const json = JSON.stringify(sorted).replace(
    /[^\x20-\x7e]|[<>&]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`
  )
  return json.length > MAX_BYTES ? null : json
}

/**
 * Puts `details` on the response. Empty sets nothing, so a write that changed nothing
 * sends no header. Over the cap sets nothing and notes it on the trace: the event still
 * records the request, just not the change.
 */
export const setDetails = (reply: FastifyReply, details: Details): void => {
  if (Object.keys(details).length === 0) return
  const value = encode(details)
  if (value === null) {
    trace.getSpan(traceContextOf(reply.request))?.addEvent("audit details not sent", {
      reason: `audit details are over ${MAX_BYTES} bytes`
    })
    return
  }
  reply.header(DETAILS_HEADER, value)
}

/** Names the id a create produced. The audit log can be searched by it. */
export const setCreated = (reply: FastifyReply, id: string): void => {
  reply.header(CREATED_HEADER, id)
}
