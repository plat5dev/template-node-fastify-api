/**
 * Access evaluation client for identity's internal API
 * (plat5 docs/reference/api/internal.md#access-evaluation).
 * Fail-closed: any non-200 response, missing boolean decision, or error throws.
 */
import { context, propagation } from "@opentelemetry/api"
import type { FastifyBaseLogger } from "fastify"
import { errorMessage } from "./errors.ts"

export type AccessQuestion = {
  memberId: string
  kind: string
  nodeId: string
  permission: string
}

export type AccessEvalOptions = {
  requestId?: string | null
  log?: FastifyBaseLogger
}

export type AccessClient = {
  evaluate: (question: AccessQuestion, opts?: AccessEvalOptions) => Promise<boolean>
}

export const accessClient = (identityUrl: string | undefined): AccessClient => {
  const baseUrl = identityUrl?.replace(/\/+$/, "")

  const ask = async (q: AccessQuestion, requestId: string | null): Promise<boolean> => {
    if (baseUrl === undefined) throw new Error("IDENTITY_INTERNAL_URL is unset")

    const headers: Record<string, string> = { "content-type": "application/json" }
    if (requestId) headers["x-request-id"] = requestId
    propagation.inject(context.active(), headers)

    const res = await fetch(`${baseUrl}/access/v1/evaluation`, {
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
    const body = (await res.json()) as { decision?: unknown } | null
    if (typeof body?.decision !== "boolean") {
      throw new Error("access evaluation answered without a boolean decision")
    }
    return body.decision
  }

  return {
    evaluate: async (question, opts = {}) => {
      const requestId = opts.requestId || null
      try {
        return await ask(question, requestId)
      } catch (err) {
        opts.log?.error(
          {
            component: "access",
            ...(requestId ? { request_id: requestId } : {}),
            error_message: errorMessage(err)
          },
          "access evaluation failed"
        )
        throw err
      }
    }
  }
}
