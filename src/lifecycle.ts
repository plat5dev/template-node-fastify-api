/**
 * Follows identity's two feeds, so the API's data goes when its environment or its person
 * does (plat5 docs/concepts/lifecycle.md#lifecycle-events).
 *
 * On the tree feed, the only event it acts on is `node.purged` for an environment: that
 * environment's tasks are deleted. A purged project's environments are purged with it,
 * each with its own event. Tasks are authored, so `member.removed` keeps them, and there is
 * no background work to stop on `node.deleted`. On the user feed, the only one is
 * `user.deleted`: that person's profile is deleted. Each feed has its own cursor, the last
 * event id acted on, kept in SQLite and advanced after acting on each page; acting again on
 * the same event changes nothing.
 */
import { trackDb, type Db } from "./db.js"
import type { ProfilesStore } from "./profiles/store.js"
import type { TasksStore } from "./tasks/store.js"

/** The time between polls while the feeds are caught up. */
export const INTERVAL_MS = 5_000
const PAGE_SIZE = 100

/** The part of a tree event the API reads. `kind` and `node_id` are a node event's. */
export type TreeEvent = {
  id: string
  type: string
  kind: string
  node_id: string
}

/** The part of a user event the API reads. */
export type UserEvent = {
  id: string
  type: string
  user_id: string
}

/** A feed's name: its row in feed_cursors, and its logs' `feed`. */
type FeedName = "tree" | "user"

/**
 * One of identity's feeds: its name, its url, the key its pages list events under, and
 * what the API does with each event.
 */
type Feed<E> = {
  name: FeedName
  url: string
  key: string
  act: (event: E) => void
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

export class LifecycleConsumer {
  private readonly tree: Feed<TreeEvent>
  private readonly user: Feed<UserEvent>
  private readonly stopped = new AbortController()
  private timer: NodeJS.Timeout | undefined

  /** Reads the feeds at `identityUrl`, identity's internal base URL. */
  constructor(
    identityUrl: string,
    private readonly db: Db,
    private readonly tasks: TasksStore,
    private readonly profiles: ProfilesStore
  ) {
    this.tree = {
      name: "tree",
      url: `${identityUrl}/internal/tree-events`,
      key: "tree_events",
      act: (event) => this.actOnTree(event)
    }
    this.user = {
      name: "user",
      url: `${identityUrl}/internal/user-events`,
      key: "user_events",
      act: (event) => this.actOnUser(event)
    }
  }

  /** Polls now and every `INTERVAL_MS` until `stop`. */
  start(): void {
    void this.tick()
  }

  stop(): void {
    this.stopped.abort()
    clearTimeout(this.timer)
  }

  private async tick(): Promise<void> {
    await this.poll()
    if (!this.stopped.signal.aborted) {
      this.timer = setTimeout(() => void this.tick(), INTERVAL_MS)
    }
  }

  /**
   * Reads the tree feed to its end, then the user feed. A feed that fails is logged and
   * doesn't stop the other; it's read again on the next poll.
   */
  async poll(): Promise<void> {
    await this.follow(this.tree)
    await this.follow(this.user)
  }

  private async follow<E extends { id: string }>(feed: Feed<E>): Promise<void> {
    try {
      await this.read(feed)
    } catch (err) {
      if (this.stopped.signal.aborted) return
      log("error", "lifecycle poll failed", {
        feed: feed.name,
        error_message: err instanceof Error ? err.message : String(err)
      })
    }
  }

  /**
   * Reads `feed` from its cursor until it has no more, acting on each page and then
   * advancing the cursor past it.
   */
  private async read<E extends { id: string }>(feed: Feed<E>): Promise<void> {
    let cursor = this.cursor(feed.name)
    for (;;) {
      const page = await this.fetch(feed, cursor)
      for (const event of page.events) feed.act(event)
      const last = page.events.at(-1)
      if (last) {
        cursor = last.id
        this.saveCursor(feed.name, cursor)
      }
      if (!page.hasMore) return
    }
  }

  private actOnTree(event: TreeEvent): void {
    if (event.type !== "node.purged" || event.kind !== "environment") return
    this.tasks.deleteByEnvironment(event.node_id)
    log("info", "purged environment's tasks deleted", {
      event_id: event.id,
      node_id: event.node_id
    })
  }

  private actOnUser(event: UserEvent): void {
    if (event.type !== "user.deleted") return
    this.profiles.delete(event.user_id)
    log("info", "profile deleted with its account", {
      event_id: event.id,
      user_id: event.user_id
    })
  }

  /** `feed`'s page after `cursor`: its events, and whether there are more. */
  private async fetch<E>(
    feed: Feed<E>,
    cursor: string
  ): Promise<{ events: E[]; hasMore: boolean }> {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) })
    if (cursor) query.set("starting_after", cursor)
    const res = await fetch(`${feed.url}?${query}`, {
      signal: AbortSignal.any([this.stopped.signal, AbortSignal.timeout(10_000)])
    })
    if (res.status !== 200) throw new Error(`${feed.name} feed answered ${res.status}`)
    const page = (await res.json()) as Record<string, unknown>
    return { events: page[feed.key] as E[], hasMore: page.has_more === true }
  }

  /** The last event id acted on in the feed, or "" before the first. */
  private cursor(feed: FeedName): string {
    return trackDb("feed_cursors.find", () => {
      const row = this.db
        .prepare(`SELECT event_id FROM feed_cursors WHERE feed = ?`)
        .get(feed) as { event_id: string } | undefined
      return row?.event_id ?? ""
    })
  }

  private saveCursor(feed: FeedName, eventId: string): void {
    trackDb("feed_cursors.save", () => {
      this.db
        .prepare(
          `INSERT INTO feed_cursors (feed, event_id) VALUES (?, ?)
           ON CONFLICT (feed) DO UPDATE SET event_id = excluded.event_id`
        )
        .run(feed, eventId)
    })
  }
}
