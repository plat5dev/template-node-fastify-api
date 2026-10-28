/**
 * Asks identity whether a member holds a permission on a node, for a member who isn't the
 * caller (plat5 docs/guides/write-a-service.md#checking-access-outside-a-request).
 *
 * Each question is one evaluation on identity's internal port (plat5
 * docs/reference/api/internal.md#access-evaluation). Only a 200 with a boolean `decision`
 * is an answer. Anything else is an error, logged with the request id, and no answer is no.
 */
import { propagation, type Context } from "@opentelemetry/api"

/** Whether the member `memberId` holds `permission` on the node `nodeId` of kind `kind`. */
export type Question = {
  memberId: string
  kind: string
  nodeId: string
  permission: string
}

export class AccessClient {
  /**
   * Asks identity at `identityUrl`, its internal base URL. Unset, every question fails:
   * there's no one to ask.
   */
  constructor(private readonly identityUrl: string | undefined) {}

  /**
   * Identity's decision. `parent` is the request's trace context, sent as `traceparent`,
   * and `requestId` its `X-Request-ID`, sent to identity and logged with a failure. Throws
   * when identity doesn't answer.
   */
  async evaluate(parent: Context, requestId: string, question: Question): Promise<boolean> {
    try {
      return await this.ask(parent, requestId, question)
    } catch (err) {
      console.log(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "error",
          message: "access evaluation failed",
          component: "access",
          request_id: requestId,
          error_message: err instanceof Error ? err.message : String(err)
        })
      )
      throw err
    }
  }

  private async ask(parent: Context, requestId: string, q: Question): Promise<boolean> {
    if (this.identityUrl === undefined) throw new Error("IDENTITY_INTERNAL_URL is unset")
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Request-ID": requestId
    }
    propagation.inject(parent, headers)
    const res = await fetch(`${this.identityUrl}/access/v1/evaluation`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        subject: { type: "member", id: q.memberId },
        resource: { type: q.kind, id: q.nodeId },
        action: { name: q.permission }
      }),
      signal: AbortSignal.timeout(10_000)
    })
    if (res.status !== 200) throw new Error(`access evaluation answered ${res.status}`)
    const answer = (await res.json()) as { decision?: unknown } | null
    if (typeof answer?.decision !== "boolean") {
      throw new Error("access evaluation answered without a decision")
    }
    return answer.decision
  }
}
