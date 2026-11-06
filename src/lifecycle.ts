/**
 * Follows identity's lifecycle log, so the API's data goes when its project or its
 * person does (plat5 docs/concepts/lifecycle.md#following-the-log).
 *
 * It asks only for the two events it acts on. `node.purged` for a project deletes that
 * project's tasks; a purged organization's projects are purged with it, each with its own
 * event. `user.deleted` deletes that person's profile. Tasks are authored, so
 * `member.removed` keeps them. One cursor, the last event id acted on, is kept in SQLite
 * with the data it cleans up, and saved in the same transaction as a page's deletes. Acting
 * again on the same event changes nothing, so the log can be replayed by resetting it.
 */
import { setTimeout as sleep } from "node:timers/promises"
import { trackDb, type Db } from "./db.js"
import type { ProfilesStore } from "./profiles/store.js"
import type { TasksStore } from "./tasks/store.js"

/** The events the API acts on, and the only ones it asks for. */
export const TYPES = "node.purged,user.deleted"
/** The wait after a failed read before asking again. */
export const RETRY_AFTER_MS = 5_000
/** Identity waits up to 25 s before a 204, so a read may take that long. */
const REQUEST_TIMEOUT_MS = 40_000
const PAGE_SIZE = 100

/** The part of an event the API reads. */
export type Event = {
  id: string
  type: string
  kind: string
  node_id: string
  user_id: string
}

/**
 * An event as Go's decoder reads it into the fields the API reads: each a string, "" when
 * absent or null; any other type is an error. A null event is all "".
 */
const decodeEvent = (raw: unknown): Event => {
  if (raw === null) raw = {}
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("event is not an object")
  const out: Event = { id: "", type: "", kind: "", node_id: "", user_id: "" }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = (Object.keys(out) as (keyof Event)[]).find(
      (n) => n === key || n === key.toLowerCase()
    )
    if (name === undefined || value === null) continue
    if (typeof value !== "string") throw new Error(`event ${name} is not a string`)
    out[name] = value
  }
  return out
}

/** A page of the log: its `events`, a list. Missing, null, or another type is an error. */
export const decodePage = (page: unknown): Event[] => {
  if (typeof page !== "object" || page === null || Array.isArray(page)) {
    throw new Error("lifecycle log: not an object")
  }
  const events = (page as Record<string, unknown>).events
  if (events === undefined || events === null) {
    throw new Error("lifecycle log: no events in its answer")
  }
  if (!Array.isArray(events)) throw new Error("lifecycle log: events: not a list")
  return events.map(decodeEvent)
}

const log = (level: string, message: string, fields: Record<string, unknown> = {}) =>
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      component: "lifecycle",
      ...fields
    })
  )

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

export class LifecycleConsumer {
  private readonly url: string

  /**
   * Reads the log at `identityUrl`, identity's internal base URL. `retryMs` is the wait
   * after an error, or after an immediate answer with no events.
   */
  constructor(
    identityUrl: string,
    private readonly db: Db,
    private readonly tasks: TasksStore,
    private readonly profiles: ProfilesStore,
    private readonly retryMs = RETRY_AFTER_MS
  ) {
    this.url = `${identityUrl}/internal/events`
  }

  /**
   * Follows the log until `signal` aborts, which also cancels a read in flight. After a
   * page or a 204 it asks again at once; after an error it logs it and asks again after
   * `retryMs`. An immediate answer with no events (an empty log, or a cursor past
   * identity's newest event) is also asked again after `retryMs`, so it isn't asked in a
   * tight loop.
   */
  async run(signal: AbortSignal): Promise<void> {
    try {
      const cursor = this.cursor()
      if (cursor === "") log("info", "following the lifecycle log from its first event")
      else log("info", "following the lifecycle log", { after: cursor })
    } catch {
      // The first step fails the same way, and logs it.
    }
    while (!signal.aborted) {
      let again = false
      let failure: unknown
      try {
        again = await this.step(signal)
      } catch (err) {
        failure = err
      }
      if (again || signal.aborted) continue
      if (failure !== undefined) {
        log("error", "lifecycle read failed", {
          error_message: errorMessage(failure),
          retry_in_ms: this.retryMs
        })
      }
      await sleep(this.retryMs, undefined, { signal }).catch(() => {})
    }
  }

  /**
   * Asks once for the events after the saved cursor, acts on them, and saves the cursor
   * past them in the same transaction as their deletes. Answers whether to ask again at
   * once: after a page of events, or a 204 (identity waited and nothing came).
   */
  async step(signal?: AbortSignal): Promise<boolean> {
    const cursor = this.cursor()
    const { events, waited } = await this.fetch(cursor, signal)
    if (events.length === 0) return waited
    this.apply(events)
    log("info", "lifecycle page read", {
      events: events.length,
      after: cursor,
      cursor: events.at(-1)!.id
    })
    return true
  }

  /**
   * Acts on a page and saves its last id as the cursor in one transaction: the deletes and
   * the cursor commit together or not at all.
   */
  private apply(events: Event[]): void {
    this.db.transaction(() => {
      for (const event of events) {
        try {
          this.act(event)
        } catch (err) {
          throw new Error(`event ${event.id}: ${errorMessage(err)}`)
        }
      }
      trackDb("feed_cursors.save", () => {
        this.db
          .prepare(
            `INSERT INTO feed_cursors (id, event_id) VALUES (1, ?)
             ON CONFLICT (id) DO UPDATE SET event_id = excluded.event_id`
          )
          .run(events.at(-1)!.id)
      })
    })()
  }

  private act(event: Event): void {
    if (event.type === "node.purged" && event.kind === "project") {
      this.tasks.deleteByProject(event.node_id)
      log("info", "purged project's tasks deleted", {
        event_id: event.id,
        node_id: event.node_id
      })
    } else if (event.type === "user.deleted") {
      this.profiles.delete(event.user_id)
      log("info", "profile deleted with its account", {
        event_id: event.id,
        user_id: event.user_id
      })
    }
  }

  /**
   * Asks for the events after `cursor`, or from the first event when there's none yet.
   * With a cursor identity waits for one; its 204 is no events, and `waited`.
   */
  private async fetch(
    cursor: string,
    signal?: AbortSignal
  ): Promise<{ events: Event[]; waited: boolean }> {
    const query = new URLSearchParams({ types: TYPES, limit: String(PAGE_SIZE) })
    if (cursor) query.set("after", cursor)
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const res = await fetch(`${this.url}?${query}`, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    })
    if (res.status !== 200) {
      await res.body?.cancel()
      if (res.status === 204) return { events: [], waited: true }
      throw new Error(`lifecycle log answered ${res.status}`)
    }
    let page: unknown
    try {
      page = await res.json()
    } catch (err) {
      throw new Error(`lifecycle log: ${errorMessage(err)}`)
    }
    return { events: decodePage(page), waited: false }
  }

  /** The last event id acted on, or "" before the first. */
  private cursor(): string {
    return trackDb("feed_cursors.find", () => {
      const row = this.db.prepare(`SELECT event_id FROM feed_cursors WHERE id = 1`).get() as
        | { event_id: string }
        | undefined
      return row?.event_id ?? ""
    })
  }
}
