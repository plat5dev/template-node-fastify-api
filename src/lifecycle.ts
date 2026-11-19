/**
 * Identity lifecycle log consumer (plat5 docs/concepts/lifecycle.md).
 * Polls `/internal/events` for `node.purged` (projects) and `user.deleted`,
 * applying deletes and advancing the SQLite cursor in a single BEGIN IMMEDIATE transaction.
 */
import { setTimeout as sleep } from "node:timers/promises"
import type { FastifyBaseLogger } from "fastify"
import { type Db, transaction } from "./db.ts"
import { errorMessage } from "./errors.ts"
import type { ProfilesStore } from "./profiles.ts"
import type { TasksStore } from "./tasks.ts"

export const TYPES = "node.purged,user.deleted"
export const RETRY_AFTER_MS = 5_000
const REQUEST_TIMEOUT_MS = 40_000
const PAGE_SIZE = 100

export type LifecycleEvent = {
  id: string
  type?: string
  kind?: string
  node_id?: string
  user_id?: string
}

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined

export const decodePage = (page: unknown): LifecycleEvent[] => {
  const events = (page as { events?: unknown } | null)?.events
  if (!Array.isArray(events)) throw new Error("lifecycle log: missing events array")
  return events.flatMap((raw: unknown) => {
    const e = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>
    const id = nonEmpty(e.id)
    if (id === undefined) return []
    return [
      {
        id,
        type: nonEmpty(e.type),
        kind: nonEmpty(e.kind),
        node_id: nonEmpty(e.node_id),
        user_id: nonEmpty(e.user_id)
      }
    ]
  })
}

export const lifecycleReader = (opts: {
  identityUrl: string
  db: Db
  tasks: TasksStore
  profiles: ProfilesStore
  log: FastifyBaseLogger
  retryMs?: number
}) => {
  const { db, tasks, profiles, retryMs = RETRY_AFTER_MS } = opts
  const baseUrl = opts.identityUrl.replace(/\/+$/, "")
  const log = opts.log.child({ component: "lifecycle" })

  const findCursor = db.prepare(`SELECT event_id FROM feed_cursors WHERE id = 1`)
  const saveCursor = db.prepare(
    `INSERT INTO feed_cursors (id, event_id) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET event_id = excluded.event_id`
  )
  const clearCursor = db.prepare(`DELETE FROM feed_cursors`)

  const cursor = (): string => (findCursor.get() as { event_id: string } | undefined)?.event_id ?? ""

  const applyEvent = (event: LifecycleEvent): void => {
    if (event.type === "node.purged" && event.kind === "project" && event.node_id) {
      tasks.deleteByProject(event.node_id)
      log.info({ event_id: event.id, node_id: event.node_id }, "purged project tasks deleted")
    } else if (event.type === "user.deleted" && event.user_id) {
      profiles.delete(event.user_id)
      log.info({ event_id: event.id, user_id: event.user_id }, "deleted user profile removed")
    }
  }

  const fetchPage = async (
    after: string,
    signal?: AbortSignal
  ): Promise<LifecycleEvent[] | "ahead"> => {
    const query = new URLSearchParams({ types: TYPES, limit: String(PAGE_SIZE) })
    if (after) query.set("after", after)

    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const res = await fetch(`${baseUrl}/internal/events?${query}`, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    })

    if (res.status === 200) return decodePage(await res.json())
    if (res.status === 204) {
      await res.body?.cancel()
      return []
    }
    if (res.status === 409) {
      const body = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null
      if (body?.error?.code === "CURSOR_AHEAD") return "ahead"
    } else {
      await res.body?.cancel()
    }
    throw new Error(`lifecycle log answered ${res.status}`)
  }

  const step = async (signal?: AbortSignal): Promise<void> => {
    const after = cursor()
    const events = await fetchPage(after, signal)
    if (events === "ahead") {
      clearCursor.run()
      log.warn({ cursor: after }, "lifecycle cursor ahead of log; resetting to first event")
      return
    }
    const last = events.at(-1)
    if (last === undefined) return

    transaction(db, () => {
      for (const event of events) {
        try {
          applyEvent(event)
        } catch (err) {
          throw new Error(`event ${event.id}: ${errorMessage(err)}`)
        }
      }
      saveCursor.run(last.id)
    })
    log.info({ events: events.length, after, cursor: last.id }, "lifecycle page processed")
  }

  const run = async (signal: AbortSignal): Promise<void> => {
    try {
      const after = cursor()
      if (after === "") log.info("following lifecycle log from first event")
      else log.info({ after }, "following lifecycle log")
    } catch {
      // First step will surface and log the DB error.
    }

    while (!signal.aborted) {
      try {
        await step(signal)
      } catch (err) {
        if (signal.aborted) break
        log.error({ error_message: errorMessage(err), retry_in_ms: retryMs }, "lifecycle read failed")
        await sleep(retryMs, undefined, { signal }).catch(() => {})
      }
    }
  }

  return { cursor, step, run }
}
