/**
 * Asks identity whether a member holds a permission on a node, for a member who isn't the
 * caller (plat5 docs/guides/write-a-service.md#checking-access-outside-a-request).
 *
 * Each question is one evaluation on identity's internal port (plat5
 * docs/reference/api/internal.md#access-evaluation). Only a 200 with a boolean `decision`
 * is an answer. Anything else is an error, logged with the request id, and no answer is no.
 */
import { type Context, propagation } from "@opentelemetry/api"
import { log, messageOf } from "./log.ts"

/** Whether the member `memberId` holds `permission` on the node `nodeId` of kind `kind`. */
export type Question = {
  memberId: string
  kind: string
  nodeId: string
  permission: string
}

export type AccessClient = {
  /**
   * Identity's decision. `parent` is the request's trace context, sent as `traceparent`, and
   * `requestId` its `X-Request-ID`, sent to identity and logged with a failure. Throws when
   * identity doesn't answer.
   */
  evaluate: (parent: Context, requestId: string | null, question: Question) => Promise<boolean>
}

/** Asks identity at `identityUrl`, its internal base URL. Unset, every question fails: there's no one to ask. */
export const accessClient = (identityUrl: string | undefined): AccessClient => {
  const ask = async (parent: Context, requestId: string | null, q: Question): Promise<boolean> => {
    if (identityUrl === undefined) throw new Error("IDENTITY_INTERNAL_URL is unset")
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (requestId !== null) headers["x-request-id"] = requestId
    propagation.inject(parent, headers)
    const res = await fetch(`${identityUrl}/access/v1/evaluation`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        subject: { type: "member", id: q.memberId },
        resource: { type: q.kind, id: q.nodeId },
        action: { name: q.permission }
      }),
      signal: AbortSignal.timeout(10_000)
    })
    if (res.status !== 200) {
      await res.body?.cancel()
      throw new Error(`access evaluation answered ${res.status}`)
    }
    const answer = (await res.json()) as { decision?: unknown } | null
    if (typeof answer?.decision !== "boolean")
      throw new Error("access evaluation answered without a decision")
    return answer.decision
  }

  return {
    evaluate: async (parent, requestId, question) => {
      try {
        return await ask(parent, requestId, question)
      } catch (err) {
        log("error", "access evaluation failed", {
          component: "access",
          request_id: requestId,
          error_message: messageOf(err)
        })
        throw err
      }
    }
  }
}
