import {
  ACTIVITY_MAX_VISIT_MS,
  type ActivitySourceState,
  activityCalendarDays,
  activityDay,
  type PlannedActivityPageView,
  planActivityAppend,
  validateActivityAppend,
} from "./policy"
import type {
  ActivityActor,
  ActivityAttribution,
  ActivityCalendarInput,
  ActivityCursor,
  ActivityDay,
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
} from "./types"

interface StoredVisit {
  readonly projectId: string
  readonly id: string
  readonly actor: ActivityActor
  readonly sessionId: string
  readonly attribution: ActivityAttribution | null
  readonly startedAt: Date
  lastSeenAt: Date
  pageViews: number
}

interface StoredPageView extends PlannedActivityPageView {
  readonly projectId: string
}

/** A source as stored: the start of its visit is read from the visit, which may be gone. */
type StoredSource = Omit<ActivitySourceState, "visitStartedAt">

interface InMemoryActivitySnapshot {
  readonly sources: Map<string, StoredSource>
  readonly visits: Map<string, StoredVisit>
  readonly pageViews: StoredPageView[]
}

/** Activity for tests and local development. Each append runs without yielding, so it is atomic. */
export class InMemoryActivityStorage implements ActivityStorage {
  private sources = new Map<string, StoredSource>()
  private visits = new Map<string, StoredVisit>()
  private pageViews: StoredPageView[] = []

  async append(input: AppendActivityInput): Promise<AppendActivityResult> {
    validateActivityAppend(input)

    const sourceKey = JSON.stringify([input.projectId, input.actor.type, input.sessionId])
    const stored = this.pageViews.filter(
      (pageView) =>
        pageView.projectId === input.projectId &&
        this.isFromSession(pageView, input) &&
        input.events.some((event) => event.id === pageView.id)
    )

    const plan = planActivityAppend(input, this.source(sourceKey, input.projectId), stored)
    if (plan.status !== "append") {
      return { status: plan.status === "duplicate" ? "accepted" : "throttled", accepted: 0 }
    }

    const visitKey = JSON.stringify([input.projectId, plan.state.visitId])
    const lastSeenAt = new Date(plan.state.lastSeenAt)

    if (plan.newVisit) {
      if (this.visits.has(visitKey)) {
        throw new Error("[Sixb] Activity visit id already exists.")
      }

      this.visits.set(visitKey, {
        projectId: input.projectId,
        id: plan.state.visitId,
        actor: structuredClone(input.actor),
        sessionId: input.sessionId,
        attribution: plan.newVisit.attribution,
        startedAt: lastSeenAt,
        lastSeenAt,
        pageViews: plan.pageViews.length,
      })
    } else {
      const visit = this.requireVisit(input.projectId, plan.state.visitId)
      visit.lastSeenAt = lastSeenAt
      visit.pageViews += plan.pageViews.length
    }

    const { visitStartedAt: _startedAt, ...source } = plan.state
    this.sources.set(sourceKey, source)
    for (const pageView of plan.pageViews) {
      this.pageViews.push({ ...pageView, projectId: input.projectId })
    }

    return { status: "accepted", accepted: plan.accepted }
  }

  async list(input: ListActivityVisitsInput): Promise<ActivityVisitsPage> {
    const visits = this.overlapping(input)
      .filter((visit) => isBefore(visit.lastSeenAt, visit.id, input.before))
      .sort(byLastSeenDescending((visit) => visit.id))

    return {
      visits: visits.slice(0, input.limit).map(toVisit),
      hasMore: visits.length > input.limit,
    }
  }

  async users(input: ListActivityUsersInput): Promise<ActivityUsersPage> {
    const byUser = new Map<string, { lastSeenAt: Date; visits: number; pageViews: number }>()

    for (const visit of this.overlapping(input)) {
      if (visit.actor.type !== "user") {
        continue
      }

      const user = byUser.get(visit.actor.userId) ?? {
        lastSeenAt: visit.lastSeenAt,
        visits: 0,
        pageViews: 0,
      }
      if (visit.lastSeenAt > user.lastSeenAt) {
        user.lastSeenAt = visit.lastSeenAt
      }
      user.visits += 1
      user.pageViews += this.pageViewsInPeriod(visit, input).length
      byUser.set(visit.actor.userId, user)
    }

    const users = [...byUser]
      .map(([userId, user]) => ({ userId, ...user }))
      .filter((user) => isBefore(user.lastSeenAt, user.userId, input.before))
      .sort(byLastSeenDescending((user) => user.userId))

    return {
      users: users.slice(0, input.limit).map((user) => ({ ...user })),
      hasMore: users.length > input.limit,
    }
  }

  async summarize(input: ActivityPeriodInput): Promise<ActivitySummary> {
    const visits = this.overlapping(input)
    const userIds = visits.flatMap((visit) =>
      visit.actor.type === "user" ? [visit.actor.userId] : []
    )

    return {
      users: new Set(userIds).size,
      visits: visits.length,
      sharedVisits: visits.filter((visit) => visit.actor.type === "share").length,
      pageViews: visits.reduce(
        (total, visit) => total + this.pageViewsInPeriod(visit, input).length,
        0
      ),
    }
  }

  async calendar(input: ActivityCalendarInput): Promise<readonly ActivityDay[]> {
    const visits = this.overlapping(input)

    const pageViewsByDay = new Map<string, number>()
    for (const visit of visits) {
      for (const pageView of this.pageViewsInPeriod(visit, input)) {
        const day = activityDay(pageView.receivedAt)
        pageViewsByDay.set(day, (pageViewsByDay.get(day) ?? 0) + 1)
      }
    }

    return activityCalendarDays(input, visits, pageViewsByDay)
  }

  async read(input: ReadActivityVisitInput): Promise<StoredActivityVisitPage | null> {
    const visit = this.visits.get(JSON.stringify([input.projectId, input.id]))
    if (!visit) {
      return null
    }

    const pageViews = this.pageViewsOf(visit).sort((left, right) => left.sequence - right.sequence)

    return {
      visit: toVisit(visit),
      sessionId: visit.sessionId,
      pageViews: pageViews.slice(0, input.limit).map((pageView) => ({
        id: pageView.id,
        visitId: pageView.visitId,
        sequence: pageView.sequence,
        route: pageView.route,
        receivedAt: new Date(pageView.receivedAt),
      })),
      hasMore: pageViews.length > input.limit,
    }
  }

  async sessionVisits(
    input: ListActivitySessionVisitsInput
  ): Promise<readonly ActivitySessionVisits[]> {
    const sessionIds = new Set(input.sessionIds)
    const bySession = new Map<string, StoredVisit[]>()

    for (const visit of this.visits.values()) {
      if (
        visit.projectId !== input.projectId ||
        visit.actor.type !== "user" ||
        visit.actor.userId !== input.userId ||
        !sessionIds.has(visit.sessionId)
      ) {
        continue
      }

      const visits = bySession.get(visit.sessionId) ?? []
      visits.push(visit)
      bySession.set(visit.sessionId, visits)
    }

    return [...bySession].map(([sessionId, visits]) => ({
      sessionId,
      visits: visits.length,
      latest: visits.sort(byStartDescending).slice(0, input.limit).map(toVisit),
    }))
  }

  snapshot(): InMemoryActivitySnapshot {
    return structuredClone({
      sources: this.sources,
      visits: this.visits,
      pageViews: this.pageViews,
    })
  }

  restore(snapshot: InMemoryActivitySnapshot): void {
    const restored = structuredClone(snapshot)
    this.sources = restored.sources
    this.visits = restored.visits
    this.pageViews = restored.pageViews
  }

  private source(key: string, projectId: string): ActivitySourceState | undefined {
    const source = this.sources.get(key)
    if (!source) {
      return undefined
    }

    const visit = this.visits.get(JSON.stringify([projectId, source.visitId]))
    return { ...source, visitStartedAt: visit ? visit.startedAt.getTime() : null }
  }

  /**
   * Visits active at some point of `[from, to)`, optionally one account's. A visit lasts less than
   * a day, so one active in the period started at most a day before it.
   */
  private overlapping(input: ActivityPeriodInput): StoredVisit[] {
    const earliestStart = input.from.getTime() - ACTIVITY_MAX_VISIT_MS
    return [...this.visits.values()].filter(
      (visit) =>
        visit.projectId === input.projectId &&
        visit.startedAt.getTime() >= earliestStart &&
        visit.startedAt < input.to &&
        visit.lastSeenAt >= input.from &&
        (input.userId === undefined ||
          (visit.actor.type === "user" && visit.actor.userId === input.userId))
    )
  }

  private pageViewsOf(visit: StoredVisit): StoredPageView[] {
    return this.pageViews.filter(
      (pageView) => pageView.projectId === visit.projectId && pageView.visitId === visit.id
    )
  }

  private pageViewsInPeriod(
    visit: StoredVisit,
    period: ActivityPeriodInput | ActivityCalendarInput
  ) {
    return this.pageViewsOf(visit).filter(
      (pageView) => pageView.receivedAt >= period.from && pageView.receivedAt < period.to
    )
  }

  private isFromSession(pageView: StoredPageView, input: AppendActivityInput): boolean {
    const visit = this.visits.get(JSON.stringify([pageView.projectId, pageView.visitId]))
    return visit?.actor.type === input.actor.type && visit.sessionId === input.sessionId
  }

  private requireVisit(projectId: string, id: string): StoredVisit {
    const visit = this.visits.get(JSON.stringify([projectId, id]))
    if (!visit) {
      throw new Error("[Sixb] Activity visit is missing.")
    }
    return visit
  }
}

function toVisit(visit: StoredVisit): ActivityVisit {
  return {
    id: visit.id,
    actor: structuredClone(visit.actor),
    attribution: structuredClone(visit.attribution),
    startedAt: new Date(visit.startedAt),
    lastSeenAt: new Date(visit.lastSeenAt),
    pageViews: visit.pageViews,
  }
}

function isBefore(at: Date, id: string, cursor: ActivityCursor | undefined): boolean {
  if (!cursor) {
    return true
  }
  return at < cursor.at || (at.getTime() === cursor.at.getTime() && id < cursor.id)
}

function byStartDescending(left: StoredVisit, right: StoredVisit): number {
  const byTime = right.startedAt.getTime() - left.startedAt.getTime()
  if (byTime !== 0) {
    return byTime
  }
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0
}

/** Newest first, then by descending id compared byte by byte, as the SQL providers sort. */
function byLastSeenDescending<T extends { readonly lastSeenAt: Date }>(id: (row: T) => string) {
  return (left: T, right: T) => {
    const byTime = right.lastSeenAt.getTime() - left.lastSeenAt.getTime()
    if (byTime !== 0) {
      return byTime
    }
    return id(left) < id(right) ? 1 : id(left) > id(right) ? -1 : 0
  }
}
