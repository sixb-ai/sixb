/**
 * The activity rules every provider shares: validation, retries, quota, visit assignment and
 * sequence. Providers own atomicity and their queries; see `src/activity/README.md`.
 */
import type {
  ActivityActor,
  ActivityAttribution,
  ActivityDay,
  ActivityEventInput,
  ActivityPageView,
  AppendActivityInput,
} from "./types"

// The HTTP schemas share these, so the API and the providers refuse the same inputs.
export const ACTIVITY_BATCH_LIMIT = 20
export const ACTIVITY_EVENT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/
export const ACTIVITY_VISIT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/
export const ACTIVITY_HOSTNAME_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
/** A UTM label: any text without control characters. */
export const ACTIVITY_LABEL_PATTERN = /^[^\x00-\x1f\x7f]*$/
export const ACTIVITY_LABEL_MAX_LENGTH = 100
export const ACTIVITY_REFERRER_MAX_LENGTH = 253
export const ACTIVITY_ROUTE_MAX_LENGTH = 512
export const ACTIVITY_ID_MAX_LENGTH = 256
export const ACTIVITY_MAX_PERIOD_MS = 31 * 24 * 60 * 60_000
export const ACTIVITY_MAX_PAGE_SIZE = 100

export const ACTIVITY_SOURCE_LIMIT_PER_MINUTE = 120
export const ACTIVITY_MIN_IDLE_TIMEOUT_MS = 60_000
/** A visit ends at its next event once this old, so a period query bounds `started_at`. */
export const ACTIVITY_MAX_VISIT_MS = 24 * 60 * 60_000

const QUOTA_WINDOW_MS = 60_000
const DAY_MS = 86_400_000
const ATTRIBUTION_KEYS = ["source", "medium", "campaign", "referrer"] as const

/** What a provider keeps per session between batches, read and written under its lock. */
export interface ActivitySourceState {
  readonly visitId: string
  /** When the current visit started; `null` once that visit was deleted. Epoch milliseconds. */
  readonly visitStartedAt: number | null
  /** Epoch milliseconds. Never moves backwards. */
  readonly lastSeenAt: number
  /** Sequence of the visit's last page view. */
  readonly sequence: number
  readonly windowStart: number
  readonly windowCount: number
}

/** A page view already stored for the session, compared with a retry of it. */
export interface StoredActivityPageView {
  readonly id: string
  readonly route: string
  readonly attribution?: ActivityAttribution
}

/** A page view to insert. Its own attribution is kept only to recognize a retry. */
export interface PlannedActivityPageView extends ActivityPageView {
  readonly attribution?: ActivityAttribution
}

export type ActivityAppendPlan =
  | { readonly status: "duplicate" }
  | { readonly status: "throttled" }
  | {
      readonly status: "append"
      /** Set when the batch starts a visit, with the arrival that visit keeps. */
      readonly newVisit: { readonly attribution: ActivityAttribution | null } | null
      readonly pageViews: readonly PlannedActivityPageView[]
      /** Events counted against the quota: page views and activity alike. */
      readonly accepted: number
      readonly state: ActivitySourceState
    }

export function validateActivityEvents(events: readonly ActivityEventInput[]): void {
  if (!Array.isArray(events) || events.length === 0 || events.length > ACTIVITY_BATCH_LIMIT) {
    throw new Error(`[Sixb] Activity batches must contain 1 to ${ACTIVITY_BATCH_LIMIT} events.`)
  }

  const ids = new Set<string>()
  for (const event of events) {
    if (
      !event ||
      typeof event.id !== "string" ||
      !ACTIVITY_EVENT_ID_PATTERN.test(event.id) ||
      ids.has(event.id)
    ) {
      throw new Error("[Sixb] Activity event ids must be unique, nonempty identifiers.")
    }
    ids.add(event.id)

    if (event.type !== "page.view" && event.type !== "visit.activity") {
      throw new Error("[Sixb] Unknown activity event type.")
    }

    if (!isActivityRoutePattern(event.route)) {
      throw new Error(
        "[Sixb] Activity routes must be normalized file-router patterns without URL parameters."
      )
    }

    serializeActivityAttribution(event.attribution)
  }
}

export function validateActivityAppend(input: AppendActivityInput): void {
  validateActivityEvents(input.events)

  if (input.actor.type !== "user" && input.actor.type !== "share") {
    throw new Error("[Sixb] Invalid activity actor.")
  }

  const actorId = input.actor.type === "user" ? input.actor.userId : input.actor.grantId
  for (const value of [input.projectId, input.sessionId, input.newVisitId, actorId]) {
    if (typeof value !== "string" || !value.trim() || value.length > ACTIVITY_ID_MAX_LENGTH) {
      throw new Error("[Sixb] Invalid activity identity.")
    }
  }

  if (
    !Number.isFinite(input.now.getTime()) ||
    !Number.isSafeInteger(input.idleTimeoutMs) ||
    input.idleTimeoutMs < ACTIVITY_MIN_IDLE_TIMEOUT_MS
  ) {
    throw new Error("[Sixb] Invalid activity clock or inactivity window.")
  }
}

/**
 * Plans one batch for one session. `current` is the session's state, absent before its first
 * batch; `stored` holds its page views whose ids appear in the batch.
 */
export function planActivityAppend(
  input: AppendActivityInput,
  current: ActivitySourceState | undefined,
  stored: readonly StoredActivityPageView[]
): ActivityAppendPlan {
  const fresh = input.events.filter((event) => !isRetry(event, stored))
  if (fresh.length === 0) {
    return { status: "duplicate" }
  }

  // A server clock stepping back must not reorder a visit.
  const now = Math.max(input.now.getTime(), current?.lastSeenAt ?? 0)

  const windowOpen = current !== undefined && now - current.windowStart < QUOTA_WINDOW_MS
  const windowStart = windowOpen ? current.windowStart : now
  const windowCount = windowOpen ? current.windowCount : 0
  if (windowCount + fresh.length > ACTIVITY_SOURCE_LIMIT_PER_MINUTE) {
    return { status: "throttled" }
  }

  const continued = continuesVisit(current, now, input.idleTimeoutMs) ? current : undefined
  const visitId = continued?.visitId ?? input.newVisitId
  const previousSequence = continued?.sequence ?? 0

  // A visit opened by activity, someone back on a page after inactivity, starts on that page.
  const pageViews = fresh
    .filter((event, index) => event.type === "page.view" || (!continued && index === 0))
    .map(
      (event, index): PlannedActivityPageView => ({
        id: event.id,
        visitId,
        sequence: previousSequence + index + 1,
        route: event.route,
        receivedAt: new Date(now),
        ...(event.attribution === undefined
          ? {}
          : { attribution: structuredClone(event.attribution) }),
      })
    )

  return {
    status: "append",
    newVisit: continued ? null : { attribution: cloneAttribution(fresh[0]?.attribution) },
    pageViews,
    accepted: fresh.length,
    state: {
      visitId,
      visitStartedAt: continued ? continued.visitStartedAt : now,
      lastSeenAt: now,
      sequence: previousSequence + pageViews.length,
      windowStart,
      windowCount: windowCount + fresh.length,
    },
  }
}

/**
 * A visit continues while it is active and younger than a day. One whose row was deleted cannot:
 * the next event starts another.
 */
function continuesVisit(
  current: ActivitySourceState | undefined,
  now: number,
  idleTimeoutMs: number
): current is ActivitySourceState {
  return (
    current !== undefined &&
    current.visitStartedAt !== null &&
    now - current.lastSeenAt < idleTimeoutMs &&
    now - current.visitStartedAt < ACTIVITY_MAX_VISIT_MS
  )
}

/**
 * An event whose id is already stored is a retry, and must say the same thing. Stored rows are
 * page views and the activity that opened a visit, so either type can retry one. Other activity
 * is not stored, and is never recognized as a retry.
 */
function isRetry(event: ActivityEventInput, stored: readonly StoredActivityPageView[]): boolean {
  const previous = stored.find((candidate) => candidate.id === event.id)
  if (!previous) {
    return false
  }

  if (
    event.route !== previous.route ||
    serializeActivityAttribution(event.attribution) !==
      serializeActivityAttribution(previous.attribution)
  ) {
    throw new Error("[Sixb] Activity event id was reused with different content.")
  }

  return true
}

/**
 * Each UTC day of `[from, to)` that a visit overlaps, with its page views. A visit across midnight
 * counts on both days.
 */
export function activityCalendarDays(
  period: { readonly from: Date; readonly to: Date },
  visits: readonly { readonly startedAt: Date; readonly lastSeenAt: Date }[],
  pageViewsByDay: ReadonlyMap<string, number>
): ActivityDay[] {
  const visitsByDay = new Map<string, number>()
  const from = period.from.getTime()
  const last = period.to.getTime() - 1

  for (const visit of visits) {
    const firstDay = Math.floor(Math.max(visit.startedAt.getTime(), from) / DAY_MS)
    const lastDay = Math.floor(Math.min(visit.lastSeenAt.getTime(), last) / DAY_MS)

    for (let day = firstDay; day <= lastDay; day++) {
      const key = activityDay(day * DAY_MS)
      visitsByDay.set(key, (visitsByDay.get(key) ?? 0) + 1)
    }
  }

  const days = new Set([...visitsByDay.keys(), ...pageViewsByDay.keys()])
  return [...days].sort().map((day) => ({
    day,
    visits: visitsByDay.get(day) ?? 0,
    pageViews: pageViewsByDay.get(day) ?? 0,
  }))
}

/** The UTC calendar day of an instant, as `YYYY-MM-DD`. */
export function activityDay(at: Date | number): string {
  return new Date(at).toISOString().slice(0, 10)
}

export function activityActor(
  type: string,
  userId: string | null,
  grantId: string | null
): ActivityActor {
  if (type === "user" && userId) {
    return { type, userId }
  }
  if (type === "share" && grantId) {
    return { type, grantId }
  }
  throw new Error("[Sixb] Stored activity actor is invalid.")
}

/** Canonical JSON, so a retry matches whatever order its keys come in. `undefined` stays null. */
export function serializeActivityAttribution(value: unknown): string | null {
  if (value === undefined) {
    return null
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("[Sixb] Invalid activity attribution.")
  }
  if (Object.keys(value).some((key) => !ATTRIBUTION_KEYS.some((field) => field === key))) {
    throw new Error("[Sixb] Unknown activity attribution field.")
  }

  const result: Record<string, string> = {}
  for (const key of ATTRIBUTION_KEYS) {
    const text: unknown = Reflect.get(value, key)
    if (text === undefined) {
      continue
    }

    const maxLength = key === "referrer" ? ACTIVITY_REFERRER_MAX_LENGTH : ACTIVITY_LABEL_MAX_LENGTH
    if (!isAttributionLabel(text, maxLength)) {
      throw new Error("[Sixb] Activity attribution requires bounded, nonempty labels.")
    }
    if (key === "referrer" && !ACTIVITY_HOSTNAME_PATTERN.test(text)) {
      throw new Error("[Sixb] Activity referrer must be a hostname, not a URL.")
    }

    result[key] = text
  }

  return JSON.stringify(result)
}

export function parseActivityAttribution(value: string | null): ActivityAttribution | null {
  if (value === null) {
    return null
  }

  const data: unknown = JSON.parse(value)
  serializeActivityAttribution(data)
  // The check above limits every key and value to the attribution contract.
  return data as ActivityAttribution
}

function cloneAttribution(value: ActivityAttribution | undefined): ActivityAttribution | null {
  return value === undefined ? null : structuredClone(value)
}

function isAttributionLabel(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    ACTIVITY_LABEL_PATTERN.test(value)
  )
}

/** A file-router pattern: rooted, normalized, without a query, fragment or escape. */
export function isActivityRoutePattern(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= ACTIVITY_ROUTE_MAX_LENGTH &&
    value.startsWith("/") &&
    !value.includes("//") &&
    !/[?#%\s\x00-\x1f]/.test(value)
  )
}
