/**
 * Follows identity's lifecycle log, so the API's data goes when its project or its person
 * does (plat5 docs/concepts/lifecycle.md#following-the-log).
 *
 * It asks only for the two events it acts on. `node.purged` for a project deletes that
 * project's tasks; a purged organization's projects are purged with it, each with its own
 * event. `user.deleted` deletes that person's profile. Tasks are authored, so
 * `member.removed` keeps them. One cursor, the last event id acted on, is kept in SQLite
 * with the data it cleans up, and saved in the same transaction as a page's deletes. Acting
 * again on the same event changes nothing, so the log can be replayed by resetting it, and a
 * cursor past the log's newest event (identity's log was reset) is cleared and the log read
 * again from its first event.
 */
import { setTimeout as sleep } from "node:timers/promises"
import { type Db, trackDb, transaction } from "./db.ts"
import { log, messageOf } from "./log.ts"
import type { ProfilesStore } from "./profiles/store.ts"
import type { TasksStore } from "./tasks/store.ts"

/** The events the API acts on, and the only ones it asks for. */
export const TYPES = "node.purged,user.deleted"
/** The wait after a failed read before asking again. */
export const RETRY_AFTER_MS = 5_000
/** Identity waits up to 25 s before a 204, so a read may take that long. */
const REQUEST_TIMEOUT_MS = 40_000
const PAGE_SIZE = 100

/** The part of an event the API reads (plat5 docs/reference/api/internal.md#lifecycle-events). */
export type Event = { id: string; type?: string; kind?: string; node_id?: string; user_id?: string }

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined

/** A page of the log: its `events`, each with the keys the API reads, by exact name. An event without an id is skipped. */
export const decodePage = (page: unknown): Event[] => {
  const events = (page as { events?: unknown } | null)?.events
  if (!Array.isArray(events)) throw new Error("lifecycle log: no list of events in its answer")
  return events.flatMap((raw: unknown) => {
    const e = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>
    const id = text(e.id)
    if (id === undefined) return []
    return [
      {
        id,
        type: text(e.type),
        kind: text(e.kind),
        node_id: text(e.node_id),
        user_id: text(e.user_id)
      }
    ]
  })
}

const note = (level: "info" | "warn" | "error", message: string, fields: Record<string, unknown> = {}) =>
  log(level, message, { component: "lifecycle", ...fields })

/**
 * The log's reader on `identityUrl`, identity's internal base URL. `retryMs` is the wait after
 * an error.
 */
export const lifecycleReader = (opts: {
  identityUrl: string
  db: Db
  tasks: TasksStore
  profiles: ProfilesStore
  retryMs?: number
}) => {
  const { identityUrl, db, tasks, profiles, retryMs = RETRY_AFTER_MS } = opts
  const findCursor = db.prepare(`SELECT event_id FROM feed_cursors WHERE id = 1`)
  const saveCursor = db.prepare(
    `INSERT INTO feed_cursors (id, event_id) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET event_id = excluded.event_id`
  )
  const clearCursor = db.prepare(`DELETE FROM feed_cursors`)

  /** The last event id acted on, or "" before the first. */
  const cursor = (): string =>
    trackDb(
      "feed_cursors.find",
      () => (findCursor.get() as { event_id: string } | undefined)?.event_id ?? ""
    )

  const act = (event: Event): void => {
    if (event.type === "node.purged" && event.kind === "project" && event.node_id) {
      tasks.deleteByProject(event.node_id)
      note("info", "purged project's tasks deleted", { event_id: event.id, node_id: event.node_id })
    } else if (event.type === "user.deleted" && event.user_id) {
      profiles.delete(event.user_id)
      note("info", "profile deleted with its account", {
        event_id: event.id,
        user_id: event.user_id
      })
    }
  }

  /**
   * Asks for the events after `after`, or from the first event when there's none yet. Identity
   * waits for one; its 204 is no events. A 409 `CURSOR_AHEAD` is `ahead`: `after` is past the
   * log's newest event.
   */
  const fetchPage = async (after: string, signal?: AbortSignal): Promise<Event[] | "ahead"> => {
    const query = new URLSearchParams({ types: TYPES, limit: String(PAGE_SIZE) })
    if (after) query.set("after", after)
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const res = await fetch(`${identityUrl}/internal/events?${query}`, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    })
    if (res.status === 200) return decodePage(await res.json())
    if (res.status === 409) {
      const body = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null
      if (body?.error?.code === "CURSOR_AHEAD") return "ahead"
    } else await res.body?.cancel()
    if (res.status === 204) return []
    throw new Error(`lifecycle log answered ${res.status}`)
  }

  /**
   * Asks once for the events after the saved cursor, acts on them, and saves the cursor past
   * them in the same transaction as their deletes. A cursor past the log's newest event is
   * cleared, so the next ask reads from the first event.
   */
  const step = async (signal?: AbortSignal): Promise<void> => {
    const after = cursor()
    const events = await fetchPage(after, signal)
    if (events === "ahead") {
      trackDb("feed_cursors.clear", () => clearCursor.run())
      note("warn", "the lifecycle log was reset: reading it again from its first event", {
        cursor: after
      })
      return
    }
    const last = events.at(-1)
    if (last === undefined) return
    transaction(db, () => {
      for (const event of events) {
        try {
          act(event)
        } catch (err) {
          throw new Error(`event ${event.id}: ${messageOf(err)}`)
        }
      }
      trackDb("feed_cursors.save", () => saveCursor.run(last.id))
    })
    note("info", "lifecycle page read", { events: events.length, after, cursor: last.id })
  }

  /**
   * Follows the log until `signal` aborts, which also cancels a read in flight. After a page,
   * a 204 or a reset it asks again at once; after an error it logs it and asks again after
   * `retryMs`, from the same cursor.
   */
  const run = async (signal: AbortSignal): Promise<void> => {
    try {
      const after = cursor()
      if (after === "") note("info", "following the lifecycle log from its first event")
      else note("info", "following the lifecycle log", { after })
    } catch {
      // The first step fails the same way, and logs it.
    }
    while (!signal.aborted) {
      try {
        await step(signal)
      } catch (err) {
        if (signal.aborted) break
        note("error", "lifecycle read failed", {
          error_message: messageOf(err),
          retry_in_ms: retryMs
        })
        await sleep(retryMs, undefined, { signal }).catch(() => {})
      }
    }
  }

  return { cursor, step, run }
}
