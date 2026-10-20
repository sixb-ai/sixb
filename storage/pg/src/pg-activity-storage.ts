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
import type { SQLClient } from "./pg-client"
import { lockAdvisoryKeys, type PgStoreClient, runPgTransaction } from "./transactions"

// Sorts after every stored timestamp, so a first page starts from the newest row.
const NO_CURSOR = { at: new Date("9999-12-31T23:59:59.999Z"), id: "" }

/** PostgreSQL activity. An advisory lock per session serializes its batches across replicas. */
export class PgActivityStorage implements ActivityStorage {
  constructor(private readonly sql: PgStoreClient) {}

  async append(input: AppendActivityInput): Promise<AppendActivityResult> {
    validateActivityAppend(input)

    return runPgTransaction(this.sql, async (sql) => {
      await lockAdvisoryKeys(sql, [
        JSON.stringify(["activity", input.projectId, input.actor.type, input.sessionId]),
      ])

      const plan = planActivityAppend(
        input,
        await readSource(sql, input),
        await readStoredEvents(sql, input)
      )
      if (plan.status !== "append") {
        return { status: plan.status === "duplicate" ? "accepted" : "throttled", accepted: 0 }
      }

      const { state } = plan
      const lastSeenAt = new Date(state.lastSeenAt)

      if (plan.newVisit) {
        const attribution =
          plan.newVisit.attribution === null
            ? null
            : serializeActivityAttribution(plan.newVisit.attribution)

        await sql`
          INSERT INTO activity_visits (
            project_id, id, actor_type, user_id, grant_id, session_id,
            started_at, last_seen_at, page_views, interactions, attribution
          ) VALUES (
            ${input.projectId}, ${state.visitId}, ${input.actor.type},
            ${input.actor.type === "user" ? input.actor.userId : null},
            ${input.actor.type === "share" ? input.actor.grantId : null},
            ${input.sessionId}, ${lastSeenAt}, ${lastSeenAt}, ${plan.pageViews.length},
            ${plan.interactions.length}, ${attribution}::text::jsonb
          )
        `
      } else {
        await sql`
          UPDATE activity_visits
          SET
            last_seen_at = ${lastSeenAt},
            page_views = page_views + ${plan.pageViews.length},
            interactions = interactions + ${plan.interactions.length}
          WHERE project_id = ${input.projectId} AND id = ${state.visitId}
        `
      }

      for (const pageView of plan.pageViews) {
        await sql`
          INSERT INTO activity_page_views (
            project_id, visit_id, sequence, id, route, received_at, attribution
          ) VALUES (
            ${input.projectId}, ${pageView.visitId}, ${pageView.sequence}, ${pageView.id},
            ${pageView.route}, ${pageView.receivedAt},
            ${serializeActivityAttribution(pageView.attribution)}::text::jsonb
          )
        `
      }

      for (const interaction of plan.interactions) {
        await sql`
          INSERT INTO activity_interactions (
            project_id, visit_id, sequence, id, name, route, received_at
          ) VALUES (
            ${input.projectId}, ${interaction.visitId}, ${interaction.sequence},
            ${interaction.id}, ${interaction.name}, ${interaction.route}, ${interaction.receivedAt}
          )
        `
      }

      await sql`
        INSERT INTO activity_sources (
          project_id, actor_type, session_id, visit_id, last_seen_at, sequence,
          window_start, window_count
        ) VALUES (
          ${input.projectId}, ${input.actor.type}, ${input.sessionId}, ${state.visitId},
          ${lastSeenAt}, ${state.sequence}, ${new Date(state.windowStart)}, ${state.windowCount}
        )
        ON CONFLICT (project_id, actor_type, session_id) DO UPDATE SET
          visit_id = excluded.visit_id,
          last_seen_at = excluded.last_seen_at,
          sequence = excluded.sequence,
          window_start = excluded.window_start,
          window_count = excluded.window_count
      `

      return { status: "accepted", accepted: plan.accepted }
    })
  }

  async list(input: ListActivityVisitsInput): Promise<ActivityVisitsPage> {
    const before = input.before ?? NO_CURSOR
    const rows = await this.sql<VisitRow[]>`
      SELECT ${this.visitColumns()}
      FROM activity_visits v
      WHERE ${this.overlapping(input)}
        AND (
          v.last_seen_at < ${before.at}
          OR (v.last_seen_at = ${before.at} AND v.id < ${before.id})
        )
      ORDER BY v.last_seen_at DESC, v.id DESC
      LIMIT ${input.limit + 1}
    `

    return {
      visits: rows.slice(0, input.limit).map(visitFromRow),
      hasMore: rows.length > input.limit,
    }
  }

  async users(input: ListActivityUsersInput): Promise<ActivityUsersPage> {
    const before: ActivityCursor = input.before ?? NO_CURSOR
    const rows = await this.sql<UserRow[]>`
      SELECT
        v.user_id,
        MAX(v.last_seen_at) AS last_seen_at,
        COUNT(DISTINCT v.id) AS visits,
        COUNT(p.id) AS page_views
      FROM activity_visits v
      LEFT JOIN activity_page_views p
        ON p.project_id = v.project_id
        AND p.visit_id = v.id
        AND p.received_at >= ${input.from}
        AND p.received_at < ${input.to}
      WHERE ${this.overlapping(input)} AND v.actor_type = 'user'
      GROUP BY v.user_id
      HAVING MAX(v.last_seen_at) < ${before.at}
        OR (MAX(v.last_seen_at) = ${before.at} AND v.user_id < ${before.id})
      ORDER BY last_seen_at DESC, v.user_id DESC
      LIMIT ${input.limit + 1}
    `

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
    const [row] = await this.sql<SummaryRow[]>`
      SELECT
        COUNT(DISTINCT v.user_id) AS users,
        COUNT(DISTINCT v.id) AS visits,
        COUNT(DISTINCT v.id) FILTER (WHERE v.actor_type = 'share') AS shared_visits,
        COUNT(p.id) AS page_views
      FROM activity_visits v
      LEFT JOIN activity_page_views p
        ON p.project_id = v.project_id
        AND p.visit_id = v.id
        AND p.received_at >= ${input.from}
        AND p.received_at < ${input.to}
      WHERE ${this.overlapping(input)}
    `

    return {
      users: Number(row?.users ?? 0),
      visits: Number(row?.visits ?? 0),
      sharedVisits: Number(row?.shared_visits ?? 0),
      pageViews: Number(row?.page_views ?? 0),
    }
  }

  async calendar(input: ActivityCalendarInput): Promise<readonly ActivityDay[]> {
    const visits = await this.sql<{ started_at: Date | string; last_seen_at: Date | string }[]>`
      SELECT v.started_at, v.last_seen_at
      FROM activity_visits v
      WHERE ${this.overlapping(input)}
    `
    const days = await this.sql<{ day: string; page_views: string }[]>`
      SELECT
        to_char(p.received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
        COUNT(*) AS page_views
      FROM activity_visits v
      JOIN activity_page_views p ON p.project_id = v.project_id AND p.visit_id = v.id
      WHERE ${this.overlapping(input)}
        AND p.received_at >= ${input.from}
        AND p.received_at < ${input.to}
      GROUP BY day
    `

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
    const [visit] = await this.sql<(VisitRow & { readonly session_id: string })[]>`
      SELECT ${this.visitColumns()}, v.session_id
      FROM activity_visits v
      WHERE v.project_id = ${input.projectId} AND v.id = ${input.id}
    `
    if (!visit) {
      return null
    }

    // Page views and interactions share the visit's sequence, so one bound covers both.
    const rows = await this.sql<EventRow[]>`
      SELECT id, visit_id, sequence, route, NULL::text AS name, received_at
      FROM activity_page_views
      WHERE project_id = ${input.projectId}
        AND visit_id = ${input.id}
      UNION ALL
      SELECT id, visit_id, sequence, route, name, received_at
      FROM activity_interactions
      WHERE project_id = ${input.projectId}
        AND visit_id = ${input.id}
      ORDER BY sequence
      LIMIT ${input.limit + 1}
    `

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
    const rows = await this.sql<SessionVisitRow[]>`
      SELECT *
      FROM (
        SELECT
          ${this.visitColumns()},
          v.session_id,
          ROW_NUMBER() OVER (
            PARTITION BY v.session_id ORDER BY v.started_at DESC, v.id DESC
          ) AS position,
          COUNT(*) OVER (PARTITION BY v.session_id) AS total
        FROM activity_visits v
        WHERE v.project_id = ${input.projectId}
          AND v.actor_type = 'user'
          AND v.session_id = ANY(${this.sql.array([...input.sessionIds])}::text[])
          AND v.user_id = ${input.userId}
      ) ranked
      WHERE position <= ${input.limit}
      ORDER BY session_id, position
    `

    const bySession = new Map<string, { visits: number; latest: ActivityVisit[] }>()
    for (const row of rows) {
      const session = bySession.get(row.session_id) ?? { visits: Number(row.total), latest: [] }
      session.latest.push(visitFromRow(row))
      bySession.set(row.session_id, session)
    }

    return [...bySession].map(([sessionId, session]) => ({ sessionId, ...session }))
  }

  /**
   * The visits `v` active in the period, and only the account's when one is asked for. A visit
   * lasts less than a day, so it started at most a day before the period: that bounds the index
   * range.
   */
  private overlapping(input: ActivityPeriodInput | ActivityCalendarInput) {
    const user = input.userId === undefined ? this.sql`` : this.sql`AND v.user_id = ${input.userId}`
    const earliestStart = new Date(input.from.getTime() - ACTIVITY_MAX_VISIT_MS)

    return this.sql`
      v.project_id = ${input.projectId}
      AND v.started_at >= ${earliestStart}
      AND v.started_at < ${input.to}
      AND v.last_seen_at >= ${input.from}
      ${user}
    `
  }

  private visitColumns() {
    return this.sql`
      v.id, v.actor_type, v.user_id, v.grant_id, v.started_at, v.last_seen_at, v.page_views,
      v.interactions, v.attribution::text AS attribution
    `
  }
}

async function readSource(
  sql: SQLClient,
  input: AppendActivityInput
): Promise<ActivitySourceState | undefined> {
  const [row] = await sql<SourceRow[]>`
    SELECT
      s.visit_id, v.started_at AS visit_started_at, s.last_seen_at, s.sequence,
      s.window_start, s.window_count
    FROM activity_sources s
    LEFT JOIN activity_visits v ON v.project_id = s.project_id AND v.id = s.visit_id
    WHERE s.project_id = ${input.projectId}
      AND s.actor_type = ${input.actor.type}
      AND s.session_id = ${input.sessionId}
  `
  if (!row) {
    return undefined
  }

  // A deleted visit leaves its source behind; the next batch starts another visit.
  return {
    visitId: row.visit_id,
    visitStartedAt: row.visit_started_at === null ? null : new Date(row.visit_started_at).getTime(),
    lastSeenAt: new Date(row.last_seen_at).getTime(),
    sequence: Number(row.sequence),
    windowStart: new Date(row.window_start).getTime(),
    windowCount: Number(row.window_count),
  }
}

/** The session's page views and interactions with an id of the batch, to recognize retries. */
async function readStoredEvents(
  sql: SQLClient,
  input: AppendActivityInput
): Promise<StoredActivityEvent[]> {
  const ids = input.events.map((event) => event.id)
  const rows = await sql<
    { id: string; route: string; name: string | null; attribution: string | null }[]
  >`
    SELECT p.id, p.route, NULL::text AS name, p.attribution::text AS attribution
    FROM activity_page_views p
    JOIN activity_visits v ON v.project_id = p.project_id AND v.id = p.visit_id
    WHERE p.project_id = ${input.projectId}
      AND p.id = ANY(${sql.array(ids)}::text[])
      AND v.actor_type = ${input.actor.type}
      AND v.session_id = ${input.sessionId}
    UNION ALL
    SELECT i.id, i.route, i.name, NULL::text AS attribution
    FROM activity_interactions i
    JOIN activity_visits v ON v.project_id = i.project_id AND v.id = i.visit_id
    WHERE i.project_id = ${input.projectId}
      AND i.id = ANY(${sql.array(ids)}::text[])
      AND v.actor_type = ${input.actor.type}
      AND v.session_id = ${input.sessionId}
  `

  return rows.map((row) => {
    if (row.name !== null) {
      return { id: row.id, route: row.route, name: row.name }
    }

    const attribution = parseActivityAttribution(row.attribution)
    return { id: row.id, route: row.route, ...(attribution ? { attribution } : {}) }
  })
}

interface SourceRow {
  readonly visit_id: string
  readonly visit_started_at: Date | string | null
  readonly last_seen_at: Date | string
  readonly sequence: number
  readonly window_start: Date | string
  readonly window_count: number
}

interface VisitRow {
  readonly id: string
  readonly actor_type: string
  readonly user_id: string | null
  readonly grant_id: string | null
  readonly started_at: Date | string
  readonly last_seen_at: Date | string
  readonly page_views: number
  readonly interactions: number
  readonly attribution: string | null
}

interface SessionVisitRow extends VisitRow {
  readonly session_id: string
  readonly total: number | string
}

interface UserRow {
  readonly user_id: string
  readonly last_seen_at: Date | string
  readonly visits: string
  readonly page_views: string
}

interface SummaryRow {
  readonly users: string
  readonly visits: string
  readonly shared_visits: string
  readonly page_views: string
}

interface PageViewRow {
  readonly id: string
  readonly visit_id: string
  readonly sequence: number
  readonly route: string
  readonly received_at: Date | string
}

/** A page view or, with a name, an interaction. */
interface EventRow extends PageViewRow {
  readonly name: string | null
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
