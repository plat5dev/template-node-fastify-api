/**
 * Audit response headers (plat5 docs/concepts/audit.md).
 * The gateway attaches these to the audit event and strips them before returning to the client.
 */
import { trace } from "@opentelemetry/api"
import type { FastifyReply } from "fastify"

export const DETAILS_HEADER = "X-Plat5-Audit-Details"
export const CREATED_HEADER = "X-Plat5-Audit-Created"
export const MAX_BYTES = 4096

export type AuditDetails = Record<string, unknown>

/** Records a `{ from, to }` diff when `from` and `to` differ. */
export const changed = (details: AuditDetails, field: string, from: unknown, to: unknown): void => {
  if (from !== to) details[field] = { from, to }
}

/** Encodes `details` as visible-ASCII JSON (escaping control/non-ASCII chars), or null if over MAX_BYTES. */
export const encode = (details: AuditDetails): string | null => {
  const json = JSON.stringify(details).replace(
    /[^\x20-\x7e]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`
  )
  return json.length > MAX_BYTES ? null : json
}

/** Sets `X-Plat5-Audit-Details` when non-empty and within MAX_BYTES. */
export const setDetails = (reply: FastifyReply, details: AuditDetails): void => {
  if (Object.keys(details).length === 0) return
  const value = encode(details)
  if (value === null) {
    trace.getActiveSpan()?.addEvent("audit details not sent", {
      reason: `audit details exceed ${MAX_BYTES} bytes`
    })
    return
  }
  reply.header(DETAILS_HEADER, value)
}

/** Sets `X-Plat5-Audit-Created` to the newly created resource ID. */
export const setCreated = (reply: FastifyReply, id: string): void => {
  reply.header(CREATED_HEADER, id)
}
