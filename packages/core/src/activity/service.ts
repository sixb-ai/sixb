import { randomUUID } from "node:crypto"
import {
  ACTIVITY_ID_MAX_LENGTH,
  ACTIVITY_MAX_PAGE_SIZE,
  ACTIVITY_MAX_PERIOD_MS,
  ACTIVITY_MIN_IDLE_TIMEOUT_MS,
  ACTIVITY_VISIT_ID_PATTERN,
  validateActivityEvents,
} from "../storage/activity/policy"
import type {
  ActivityActor,
  ActivityCursor,
  ActivityDay,
  ActivityEventInput,
  ActivityPeriodInput,
  ActivityStorage,
  ActivitySummary,
  ActivityUsersPage,
  ActivityVisitPage,
  ActivityVisitsPage,
} from "../storage/activity/types"

export interface ActivityOptions {
  /** Record visits and page views in the project's app and its shared links. Off by default. */
  readonly enabled?: boolean
  /** A new visit begins after this long without foreground activity. Default: 30 minutes. */
  readonly idleTimeoutMs?: number
}

/** What a browser needs to know before it sends anything. */
export interface ActivityCaptureOptions {
  readonly enabled: boolean
  readonly idleTimeoutMs: number
}

export interface ActivityCaptureResult {
  readonly status: "accepted" | "throttled" | "disabled"
  readonly accepted: number
}

/** Visits active in `[from, to)`, at most 31 days, and the page views received in it. */
export interface ActivityPeriodQuery {
  readonly from: Date
  readonly to: Date
  /** Only this account's visits. */
  readonly userId?: string
}

export interface ActivityPageQuery extends ActivityPeriodQuery {
  /** 1 to 100. Default: 50. */
  readonly limit?: number
  /** The last row of the previous page: its `lastSeenAt`, and its visit or user id. */
  readonly before?: ActivityCursor
}

export interface ActivityCalendarQuery {
  readonly userId: string
  /** A UTC calendar year. */
  readonly year: number
}

export interface ActivityCalendar {
  readonly userId: string
  readonly year: number
  readonly days: readonly ActivityDay[]
}

export interface ActivityTimelineQuery {
  /** Page views after this sequence. Default: 0, from the first. */
  readonly afterSequence?: number
  /** 1 to 100. Default: 50. */
  readonly limit?: number
}

/** The session whose browser sent a batch, from its verified authorization. */
export interface ActivitySource {
  readonly actor: ActivityActor
  readonly sessionId: string
}

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000
const MAX_IDLE_TIMEOUT_MS = 24 * 60 * 60_000

/** Validates queries and holds the project's activity settings. Authorization is the caller's. */
export class ActivityService {
  readonly captureOptions: ActivityCaptureOptions

  constructor(
    private readonly projectId: string,
    private readonly storage: ActivityStorage | undefined,
    options: ActivityOptions = {},
    private readonly now = () => new Date()
  ) {
    const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    if (
      !Number.isSafeInteger(idleTimeoutMs) ||
      idleTimeoutMs < ACTIVITY_MIN_IDLE_TIMEOUT_MS ||
      idleTimeoutMs > MAX_IDLE_TIMEOUT_MS
    ) {
      throw new Error(
        `[Sixb] activity.idleTimeoutMs must be an integer between ${ACTIVITY_MIN_IDLE_TIMEOUT_MS} and ${MAX_IDLE_TIMEOUT_MS} milliseconds.`
      )
    }

    this.captureOptions = Object.freeze({ enabled: options.enabled === true, idleTimeoutMs })

    if (this.captureOptions.enabled && !storage) {
      throw new Error(
        "[Sixb] activity.enabled needs a storage with an activity store, such as a migrated SQLite or PostgreSQL storage."
      )
    }
  }

  async capture(
    source: ActivitySource,
    events: readonly ActivityEventInput[]
  ): Promise<ActivityCaptureResult> {
    validateActivityEvents(events)

    if (!this.captureOptions.enabled) {
      return { status: "disabled", accepted: 0 }
    }

    return this.requireStorage().append({
      projectId: this.projectId,
      actor: source.actor,
      sessionId: source.sessionId,
      events,
      now: this.now(),
      idleTimeoutMs: this.captureOptions.idleTimeoutMs,
      newVisitId: `visit_${randomUUID()}`,
    })
  }

  list(query: ActivityPageQuery): Promise<ActivityVisitsPage> {
    return this.requireStorage().list({
      ...this.period(query),
      limit: pageLimit(query.limit),
      before: cursor(query.before),
    })
  }

  users(query: ActivityPageQuery): Promise<ActivityUsersPage> {
    return this.requireStorage().users({
      ...this.period(query),
      limit: pageLimit(query.limit),
      before: cursor(query.before),
    })
  }

  summarize(query: ActivityPeriodQuery): Promise<ActivitySummary> {
    return this.requireStorage().summarize(this.period(query))
  }

  async calendar(query: ActivityCalendarQuery): Promise<ActivityCalendar> {
    validateUserId(query.userId)

    if (!Number.isSafeInteger(query.year) || query.year < 1970 || query.year > 9998) {
      throw new Error("[Sixb] Activity calendar year must be between 1970 and 9998.")
    }

    const days = await this.requireStorage().calendar({
      projectId: this.projectId,
      userId: query.userId,
      from: new Date(Date.UTC(query.year, 0, 1)),
      to: new Date(Date.UTC(query.year + 1, 0, 1)),
    })

    return { userId: query.userId, year: query.year, days }
  }

  read(id: string, query: ActivityTimelineQuery = {}): Promise<ActivityVisitPage | null> {
    const afterSequence = query.afterSequence ?? 0
    if (
      typeof id !== "string" ||
      !ACTIVITY_VISIT_ID_PATTERN.test(id) ||
      !Number.isSafeInteger(afterSequence) ||
      afterSequence < 0
    ) {
      throw new Error("[Sixb] Invalid activity visit id or sequence.")
    }

    return this.requireStorage().read({
      projectId: this.projectId,
      id,
      afterSequence,
      limit: pageLimit(query.limit),
    })
  }

  private period(query: ActivityPeriodQuery): ActivityPeriodInput {
    if (query.userId !== undefined) {
      validateUserId(query.userId)
    }

    const from = query.from.getTime()
    const to = query.to.getTime()
    if (
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      from >= to ||
      to - from > ACTIVITY_MAX_PERIOD_MS
    ) {
      throw new Error("[Sixb] Activity queries require an ordered period of at most 31 days.")
    }

    return { projectId: this.projectId, from: query.from, to: query.to, userId: query.userId }
  }

  private requireStorage(): ActivityStorage {
    if (!this.storage) {
      throw new Error("[Sixb] This project's storage has no activity store.")
    }
    return this.storage
  }
}

function validateUserId(value: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > ACTIVITY_ID_MAX_LENGTH) {
    throw new Error(
      `[Sixb] Activity userId must be a nonempty user id of at most ${ACTIVITY_ID_MAX_LENGTH} characters.`
    )
  }
}

function cursor(value: ActivityCursor | undefined): ActivityCursor | undefined {
  if (
    value &&
    (!Number.isFinite(value.at.getTime()) ||
      !value.id.trim() ||
      value.id.length > ACTIVITY_ID_MAX_LENGTH)
  ) {
    throw new Error("[Sixb] Invalid activity cursor.")
  }
  return value
}

function pageLimit(value = 50): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > ACTIVITY_MAX_PAGE_SIZE) {
    throw new Error(`[Sixb] Activity page size must be between 1 and ${ACTIVITY_MAX_PAGE_SIZE}.`)
  }
  return value
}
