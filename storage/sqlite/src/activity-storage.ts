import type { Database, SQLQueryBindings } from "bun:sqlite"
import {
  ACTIVITY_MAX_VISIT_MS,
  type ActivitySourceState,
  activityActor,
  activityCalendarDays,
  parseActivityAttribution,
  planActivityAppend,
  type StoredActivityEvent,
  serializeActivityAttribution,
  validateActivityAppend,
} from "@sixb/core/internal/storage"
import type {
  ActivityCalendarInput,
  ActivityCursor,
  ActivityDay,
  ActivityInteraction,
  ActivityPageView,
  ActivityPeriodInput,
  ActivitySessionVisits,
  ActivityStorage,
  ActivitySummary,
  ActivityUsersPage,
  ActivityVisit,
  ActivityVisitsPage,
  AppendActivityInput,
  AppendActivityResult,
  ListActivitySessionVisitsInput,
  ListActivityUsersInput,
  ListActivityVisitsInput,
  ReadActivityVisitInput,
  StoredActivityVisitPage,
} from "@sixb/core/storage"
import { runImmediateTransaction, type SqliteStoreConnection } from "./transactions"

const VISIT_COLUMNS = `
  v.id, v.actor_type, v.user_id, v.grant_id, v.started_at, v.last_seen_at, v.page_views,
  v.interactions, v.attribution
`

// Sorts after every stored timestamp, so a first page starts from the newest row.
const NO_CURSOR = { at: "9999-12-31T23:59:59.999Z", id: "" }

/** SQLite activity. The immediate transaction is the source lock; the policy decides the rest. */
export class SqliteActivityStorage implements ActivityStorage {
  private readonly db: Database

  constructor(connection: SqliteStoreConnection) {
    this.db = connection.db
  }

  async append(input: AppendActivityInput): Promise<AppendActivityResult> {
    validateActivityAppend(input)

    return runImmediateTransaction(this.db, () => {
      const plan = planActivityAppend(input, this.source(input), this.storedEvents(input))
      if (plan.status !== "append") {
        return { status: plan.status === "duplicate" ? "accepted" : "throttled", accepted: 0 }
      }

      const { state } = plan
      const lastSeenAt = iso(state.lastSeenAt)

      if (plan.newVisit) {
        this.run(
          `
            INSERT INTO activity_visits (
              project_id, id, actor_type, user_id, grant_id, session_id,
              started_at, last_seen_at, page_views, interactions, attribution
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          input.projectId,
          state.visitId,
          input.actor.type,
          input.actor.type === "user" ? input.actor.userId : null,
          input.actor.type === "share" ? input.actor.grantId : null,
          input.sessionId,
          lastSeenAt,
          lastSeenAt,
          plan.pageViews.length,
          plan.interactions.length,
          plan.newVisit.attribution === null
            ? null
            : serializeActivityAttribution(plan.newVisit.attribution)
        )
      } else {
        this.run(
          `
            UPDATE activity_visits
            SET
              last_seen_at = ?,
              page_views = page_views + ?,
              interactions = interactions + ?
            WHERE project_id = ? AND id = ?
          `,
          lastSeenAt,
          plan.pageViews.length,
          plan.interactions.length,
          input.projectId,
          state.visitId
        )
      }

      for (const pageView of plan.pageViews) {
        this.run(
          `
            INSERT INTO activity_page_views (
              project_id, visit_id, sequence, id, route, received_at, attribution
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
          input.projectId,
          pageView.visitId,
          pageView.sequence,
          pageView.id,
          pageView.route,
          pageView.receivedAt.toISOString(),
          serializeActivityAttribution(pageView.attribution)
        )
      }

      for (const interaction of plan.interactions) {
        this.run(
          `
            INSERT INTO activity_interactions (
              project_id, visit_id, sequence, id, name, route, received_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
          input.projectId,
          interaction.visitId,
          interaction.sequence,
          interaction.id,
          interaction.name,
          interaction.route,
          interaction.receivedAt.toISOString()
        )
      }

      this.run(
        `
          INSERT INTO activity_sources (
            project_id, actor_type, session_id, visit_id, last_seen_at, sequence,
            window_start, window_count
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (project_id, actor_type, session_id) DO UPDATE SET
            visit_id = excluded.visit_id,
            last_seen_at = excluded.last_seen_at,
            sequence = excluded.sequence,
            window_start = excluded.window_start,
            window_count = excluded.window_count
        `,
        input.projectId,
        input.actor.type,
        input.sessionId,
        state.visitId,
        lastSeenAt,
        state.sequence,
        iso(state.windowStart),
        state.windowCount
      )

      return { status: "accepted", accepted: plan.accepted }
    })
  }

  async list(input: ListActivityVisitsInput): Promise<ActivityVisitsPage> {
    const period = overlapping(input)
    const before = cursorOf(input.before)
    const rows = this.all<VisitRow>(
      `
        SELECT ${VISIT_COLUMNS}
        FROM activity_visits v
        WHERE ${period.where}
          AND (v.last_seen_at < ? OR (v.last_seen_at = ? AND v.id < ?))
        ORDER BY v.last_seen_at DESC, v.id DESC
        LIMIT ?
      `,
      ...period.params,
      before.at,
      before.at,
      before.id,
      input.limit + 1
    )

    return {
      visits: rows.slice(0, input.limit).map(visitFromRow),
      hasMore: rows.length > input.limit,
    }
  }

  async users(input: ListActivityUsersInput): Promise<ActivityUsersPage> {
    const period = overlapping(input)
    const before = cursorOf(input.before)
    const rows = this.all<UserRow>(
      `
        SELECT
          v.user_id,
          MAX(v.last_seen_at) AS last_seen_at,
          COUNT(DISTINCT v.id) AS visits,
          COUNT(p.id) AS page_views
        FROM activity_visits v
        LEFT JOIN activity_page_views p
          ON p.project_id = v.project_id
          AND p.visit_id = v.id
          AND p.received_at >= ?
          AND p.received_at < ?
        WHERE ${period.where} AND v.actor_type = 'user'
        GROUP BY v.user_id
        HAVING MAX(v.last_seen_at) < ? OR (MAX(v.last_seen_at) = ? AND v.user_id < ?)
        ORDER BY last_seen_at DESC, v.user_id DESC
        LIMIT ?
      `,
      input.from.toISOString(),
      input.to.toISOString(),
      ...period.params,
      before.at,
      before.at,
      before.id,
      input.limit + 1
    )

    return {
      users: rows.slice(0, input.limit).map((row) => ({
        userId: row.user_id,
        lastSeenAt: new Date(row.last_seen_at),
        visits: Number(row.visits),
        pageViews: Number(row.page_views),
      })),
      hasMore: rows.length > input.limit,
    }
  }

  async summarize(input: ActivityPeriodInput): Promise<ActivitySummary> {
    const period = overlapping(input)
    const [row] = this.all<SummaryRow>(
      `
        SELECT
          COUNT(DISTINCT v.user_id) AS users,
          COUNT(DISTINCT v.id) AS visits,
          COUNT(DISTINCT CASE WHEN v.actor_type = 'share' THEN v.id END) AS shared_visits,
          COUNT(p.id) AS page_views
        FROM activity_visits v
        LEFT JOIN activity_page_views p
          ON p.project_id = v.project_id
          AND p.visit_id = v.id
          AND p.received_at >= ?
          AND p.received_at < ?
        WHERE ${period.where}
      `,
      input.from.toISOString(),
      input.to.toISOString(),
      ...period.params
    )

    return {
      users: Number(row?.users ?? 0),
      visits: Number(row?.visits ?? 0),
      sharedVisits: Number(row?.shared_visits ?? 0),
      pageViews: Number(row?.page_views ?? 0),
    }
  }

  async calendar(input: ActivityCalendarInput): Promise<readonly ActivityDay[]> {
    const period = overlapping(input)
    const visits = this.all<{ started_at: string; last_seen_at: string }>(
      `
        SELECT v.started_at, v.last_seen_at
        FROM activity_visits v
        WHERE ${period.where}
      `,
      ...period.params
    )
    const days = this.all<{ day: string; page_views: number }>(
      `
        SELECT substr(p.received_at, 1, 10) AS day, COUNT(*) AS page_views
        FROM activity_visits v
        JOIN activity_page_views p ON p.project_id = v.project_id AND p.visit_id = v.id
        WHERE ${period.where}
          AND p.received_at >= ?
          AND p.received_at < ?
        GROUP BY day
      `,
      ...period.params,
      input.from.toISOString(),
      input.to.toISOString()
    )

    return activityCalendarDays(
      input,
      visits.map((visit) => ({
        startedAt: new Date(visit.started_at),
        lastSeenAt: new Date(visit.last_seen_at),
      })),
      new Map(days.map((row) => [row.day, Number(row.page_views)]))
    )
  }

  async read(input: ReadActivityVisitInput): Promise<StoredActivityVisitPage | null> {
    const [visit] = this.all<VisitRow & { readonly session_id: string }>(
      `
        SELECT ${VISIT_COLUMNS}, v.session_id
        FROM activity_visits v
        WHERE v.project_id = ? AND v.id = ?
      `,
      input.projectId,
      input.id
    )
    if (!visit) {
      return null
    }

    // Page views and interactions share the visit's sequence, so one bound covers both.
    const rows = this.all<EventRow>(
      `
        SELECT id, visit_id, sequence, route, NULL AS name, received_at
        FROM activity_page_views
        WHERE project_id = ? AND visit_id = ?
        UNION ALL
        SELECT id, visit_id, sequence, route, name, received_at
        FROM activity_interactions
        WHERE project_id = ? AND visit_id = ?
        ORDER BY sequence
        LIMIT ?
      `,
      input.projectId,
      input.id,
      input.projectId,
      input.id,
      input.limit + 1
    )

    const pageViews: ActivityPageView[] = []
    const interactions: ActivityInteraction[] = []
    for (const row of rows.slice(0, input.limit)) {
      if (row.name === null) {
        pageViews.push(pageViewFromRow(row))
      } else {
        interactions.push({ ...pageViewFromRow(row), name: row.name })
      }
    }

    return {
      visit: visitFromRow(visit),
      sessionId: visit.session_id,
      pageViews,
      interactions,
      hasMore: rows.length > input.limit,
    }
  }

  async sessionVisits(
    input: ListActivitySessionVisitsInput
  ): Promise<readonly ActivitySessionVisits[]> {
    if (input.sessionIds.length === 0) {
      return []
    }

    // A session opens a visit per return after inactivity, so each has a few to rank.
    const rows = this.all<SessionVisitRow>(
      `
        SELECT *
        FROM (
          SELECT
            ${VISIT_COLUMNS},
            v.session_id,
            ROW_NUMBER() OVER (
              PARTITION BY v.session_id ORDER BY v.started_at DESC, v.id DESC
            ) AS position,
            COUNT(*) OVER (PARTITION BY v.session_id) AS total
          FROM activity_visits v
          WHERE v.project_id = ?
            AND v.actor_type = 'user'
            AND v.session_id IN (SELECT value FROM json_each(?))
            AND v.user_id = ?
        )
        WHERE position <= ?
        ORDER BY session_id, position
      `,
      input.projectId,
      JSON.stringify(input.sessionIds),
      input.userId,
      input.limit
    )

    const bySession = new Map<string, { visits: number; latest: ActivityVisit[] }>()
    for (const row of rows) {
      const session = bySession.get(row.session_id) ?? { visits: Number(row.total), latest: [] }
      session.latest.push(visitFromRow(row))
      bySession.set(row.session_id, session)
    }

    return [...bySession].map(([sessionId, session]) => ({ sessionId, ...session }))
  }

  private source(input: AppendActivityInput): ActivitySourceState | undefined {
    const [row] = this.all<SourceRow>(
      `
        SELECT
          s.visit_id, v.started_at AS visit_started_at, s.last_seen_at, s.sequence,
          s.window_start, s.window_count
        FROM activity_sources s
        LEFT JOIN activity_visits v ON v.project_id = s.project_id AND v.id = s.visit_id
        WHERE s.project_id = ? AND s.actor_type = ? AND s.session_id = ?
      `,
      input.projectId,
      input.actor.type,
      input.sessionId
    )
    if (!row) {
      return undefined
    }

    // A deleted visit leaves its source behind; the next batch starts another visit.
    return {
      visitId: row.visit_id,
      visitStartedAt: row.visit_started_at === null ? null : Date.parse(row.visit_started_at),
      lastSeenAt: Date.parse(row.last_seen_at),
      sequence: Number(row.sequence),
      windowStart: Date.parse(row.window_start),
      windowCount: Number(row.window_count),
    }
  }

  /** The session's page views and interactions with an id of the batch, to recognize retries. */
  private storedEvents(input: AppendActivityInput): StoredActivityEvent[] {
    const ids = JSON.stringify(input.events.map((event) => event.id))
    const rows = this.all<{
      id: string
      route: string
      name: string | null
      attribution: string | null
    }>(
      `
        SELECT p.id, p.route, NULL AS name, p.attribution
        FROM activity_page_views p
        JOIN activity_visits v ON v.project_id = p.project_id AND v.id = p.visit_id
        WHERE p.project_id = ?
          AND p.id IN (SELECT value FROM json_each(?))
          AND v.actor_type = ?
          AND v.session_id = ?
        UNION ALL
        SELECT i.id, i.route, i.name, NULL AS attribution
        FROM activity_interactions i
        JOIN activity_visits v ON v.project_id = i.project_id AND v.id = i.visit_id
        WHERE i.project_id = ?
          AND i.id IN (SELECT value FROM json_each(?))
          AND v.actor_type = ?
          AND v.session_id = ?
      `,
      input.projectId,
      ids,
      input.actor.type,
      input.sessionId,
      input.projectId,
      ids,
      input.actor.type,
      input.sessionId
    )

    return rows.map((row) => {
      if (row.name !== null) {
        return { id: row.id, route: row.route, name: row.name }
      }

      const attribution = parseActivityAttribution(row.attribution)
      return { id: row.id, route: row.route, ...(attribution ? { attribution } : {}) }
    })
  }

  private run(sql: string, ...params: SQLQueryBindings[]): void {
    this.db.query<unknown, SQLQueryBindings[]>(sql).run(...params)
  }

  private all<T>(sql: string, ...params: SQLQueryBindings[]): T[] {
    return this.db.query<T, SQLQueryBindings[]>(sql).all(...params)
  }
}

interface SourceRow {
  readonly visit_id: string
  readonly visit_started_at: string | null
  readonly last_seen_at: string
  readonly sequence: number
  readonly window_start: string
  readonly window_count: number
}

interface VisitRow {
  readonly id: string
  readonly actor_type: string
  readonly user_id: string | null
  readonly grant_id: string | null
  readonly started_at: string
  readonly last_seen_at: string
  readonly page_views: number
  readonly interactions: number
  readonly attribution: string | null
}

interface SessionVisitRow extends VisitRow {
  readonly session_id: string
  readonly total: number
}

interface UserRow {
  readonly user_id: string
  readonly last_seen_at: string
  readonly visits: number
  readonly page_views: number
}

interface SummaryRow {
  readonly users: number
  readonly visits: number
  readonly shared_visits: number
  readonly page_views: number
}

interface PageViewRow {
  readonly id: string
  readonly visit_id: string
  readonly sequence: number
  readonly route: string
  readonly received_at: string
}

/** A page view or, with a name, an interaction. */
interface EventRow extends PageViewRow {
  readonly name: string | null
}

/**
 * The visits `v` active in the period, and only the account's when one is asked for. A visit lasts
 * less than a day, so it started at most a day before the period: that bounds the index range.
 */
function overlapping(input: ActivityPeriodInput | ActivityCalendarInput): {
  readonly where: string
  readonly params: SQLQueryBindings[]
} {
  const conditions = [
    "v.project_id = ?",
    "v.started_at >= ?",
    "v.started_at < ?",
    "v.last_seen_at >= ?",
  ]
  const params: SQLQueryBindings[] = [
    input.projectId,
    new Date(input.from.getTime() - ACTIVITY_MAX_VISIT_MS).toISOString(),
    input.to.toISOString(),
    input.from.toISOString(),
  ]

  if (input.userId !== undefined) {
    conditions.push("v.user_id = ?")
    params.push(input.userId)
  }

  return { where: conditions.join(" AND "), params }
}

function cursorOf(cursor: ActivityCursor | undefined): { at: string; id: string } {
  return cursor ? { at: cursor.at.toISOString(), id: cursor.id } : NO_CURSOR
}

function visitFromRow(row: VisitRow): ActivityVisit {
  return {
    id: row.id,
    actor: activityActor(row.actor_type, row.user_id, row.grant_id),
    attribution: parseActivityAttribution(row.attribution),
    startedAt: new Date(row.started_at),
    lastSeenAt: new Date(row.last_seen_at),
    pageViews: Number(row.page_views),
    interactions: Number(row.interactions),
  }
}

function pageViewFromRow(row: PageViewRow): ActivityPageView {
  return {
    id: row.id,
    visitId: row.visit_id,
    sequence: Number(row.sequence),
    route: row.route,
    receivedAt: new Date(row.received_at),
  }
}

function iso(epochMs: number): string {
  return new Date(epochMs).toISOString()
}
