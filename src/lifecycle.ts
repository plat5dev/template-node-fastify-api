/**
 * Follows identity's lifecycle feed, so the API's data goes when its project does (plat5
 * docs/concepts/lifecycle.md#lifecycle-events).
 *
 * The only event it acts on is `node.purged` for a project: that project's tasks are
 * deleted. Tasks are authored, so `member.removed` keeps them, and there is no background
 * work to stop on `node.deleted`. The cursor is the last event id acted on, kept in SQLite
 * and advanced after acting; acting again on the same event changes nothing.
 */
import { trackDb, type Db } from "./db.js"
import type { TasksStore } from "./tasks/store.js"

/** The time between polls while the feed is caught up. */
export const INTERVAL_MS = 5_000
const PAGE_SIZE = 100

/** The part of a lifecycle event the API reads. */
export type LifecycleEvent = {
  id: string
  type: string
  kind: string
  node_id: string
}

type FeedPage = { lifecycle_events: LifecycleEvent[]; has_more: boolean }

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

export class LifecycleConsumer {
  private readonly feedUrl: string
  private readonly stopped = new AbortController()
  private timer: NodeJS.Timeout | undefined

  /** Reads the feed at `identityUrl`, identity's internal base URL. */
  constructor(
    identityUrl: string,
    private readonly db: Db,
    private readonly tasks: TasksStore
  ) {
    this.feedUrl = `${identityUrl}/internal/lifecycle-events`
  }

  /**
   * Polls now and every `INTERVAL_MS` until `stop`. A failed poll is logged and tried
   * again on the next tick.
   */
  start(): void {
    void this.tick()
  }

  stop(): void {
    this.stopped.abort()
    clearTimeout(this.timer)
  }

  private async tick(): Promise<void> {
    try {
      await this.poll()
    } catch (err) {
      if (this.stopped.signal.aborted) return
      log("error", "lifecycle poll failed", {
        error_message: err instanceof Error ? err.message : String(err)
      })
    }
    if (!this.stopped.signal.aborted) {
      this.timer = setTimeout(() => void this.tick(), INTERVAL_MS)
    }
  }

  /**
   * Reads from the cursor until the feed has no more, acting on each page and then
   * advancing the cursor past it.
   */
  async poll(): Promise<void> {
    let cursor = this.cursor()
    for (;;) {
      const page = await this.fetch(cursor)
      for (const event of page.lifecycle_events) this.act(event)
      const last = page.lifecycle_events.at(-1)
      if (last) {
        cursor = last.id
        this.saveCursor(cursor)
      }
      if (!page.has_more) return
    }
  }

  private act(event: LifecycleEvent): void {
    if (event.type !== "node.purged" || event.kind !== "project") return
    this.tasks.deleteByProject(event.node_id)
    log("info", "purged project's tasks deleted", {
      event_id: event.id,
      node_id: event.node_id
    })
  }

  private async fetch(cursor: string): Promise<FeedPage> {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) })
    if (cursor) query.set("starting_after", cursor)
    const res = await fetch(`${this.feedUrl}?${query}`, {
      signal: AbortSignal.any([this.stopped.signal, AbortSignal.timeout(10_000)])
    })
    if (res.status !== 200) throw new Error(`lifecycle feed answered ${res.status}`)
    return (await res.json()) as FeedPage
  }

  /** The last event id acted on, or "" before the first. */
  private cursor(): string {
    return trackDb("lifecycle_cursor.find", () => {
      const row = this.db
        .prepare(`SELECT event_id FROM lifecycle_cursor WHERE id = 1`)
        .get() as { event_id: string } | undefined
      return row?.event_id ?? ""
    })
  }

  private saveCursor(eventId: string): void {
    trackDb("lifecycle_cursor.save", () => {
      this.db
        .prepare(
          `INSERT INTO lifecycle_cursor (id, event_id) VALUES (1, ?)
           ON CONFLICT (id) DO UPDATE SET event_id = excluded.event_id`
        )
        .run(eventId)
    })
  }
}
