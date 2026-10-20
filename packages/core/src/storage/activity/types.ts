/** Who a visit belongs to: the verified account, or the share grant a link opened. */
export type ActivityActor =
  | { readonly type: "user"; readonly userId: string }
  | { readonly type: "share"; readonly grantId: string }

/** Arrival metadata. An empty object means direct; `null` means it was not collected. */
export interface ActivityAttribution {
  readonly source?: string
  readonly medium?: string
  readonly campaign?: string
  /** External hostname only, without path, query, credentials or fragment. */
  readonly referrer?: string
}

/**
 * `page.view` is a load or a navigation, and is kept. `visit.activity` is foreground activity: it
 * keeps the visit alive and is not stored.
 */
export type ActivityEventType = "page.view" | "visit.activity"

export interface ActivityEventInput {
  /** Chosen by the browser, so a retried event is recognized. */
  readonly id: string
  readonly type: ActivityEventType
  /** File-router pattern, never a concrete URL, search string, title, or DOM content. */
  readonly route: string
  readonly attribution?: ActivityAttribution
}

export interface ActivityVisit {
  readonly id: string
  readonly actor: ActivityActor
  /** Fixed by the first accepted event of the visit. */
  readonly attribution: ActivityAttribution | null
  readonly startedAt: Date
  readonly lastSeenAt: Date
  /** Every page view of the visit, including those outside the period that listed it. */
  readonly pageViews: number
}

export interface ActivityPageView {
  readonly id: string
  readonly visitId: string
  /** Position in the visit, from 1. */
  readonly sequence: number
  readonly route: string
  /** Server receipt time. Browser delivery is best effort, not an audit trail. */
  readonly receivedAt: Date
}

export interface AppendActivityInput {
  readonly projectId: string
  readonly actor: ActivityActor
  /**
   * The verified session the events came through: the `SessionRecord` id for a user, the shared
   * session's id for a share. Stored on the visit and never returned by reads.
   */
  readonly sessionId: string
  readonly events: readonly ActivityEventInput[]
  readonly now: Date
  readonly idleTimeoutMs: number
  /** Used only when this batch starts a visit. */
  readonly newVisitId: string
}

export interface AppendActivityResult {
  readonly status: "accepted" | "throttled"
  /** Events taken into account; a retried page view counts zero. */
  readonly accepted: number
}

/** Visits overlapping `[from, to)`, and page views received in it. */
export interface ActivityPeriodInput {
  readonly projectId: string
  readonly from: Date
  readonly to: Date
  /** Only this account's visits; a share is never counted as a user. */
  readonly userId?: string
}

/** Continue after this row of a list ordered by last activity, newest first. */
export interface ActivityCursor {
  readonly at: Date
  readonly id: string
}

export interface ListActivityVisitsInput extends ActivityPeriodInput {
  readonly limit: number
  readonly before?: ActivityCursor
}

export interface ActivityVisitsPage {
  readonly visits: readonly ActivityVisit[]
  readonly hasMore: boolean
}

export interface ListActivityUsersInput extends ActivityPeriodInput {
  readonly limit: number
  /** `id` is the user id of the last row. */
  readonly before?: ActivityCursor
}

export interface ActivityUser {
  readonly userId: string
  readonly lastSeenAt: Date
  readonly visits: number
  /** Page views received in the period. */
  readonly pageViews: number
}

export interface ActivityUsersPage {
  readonly users: readonly ActivityUser[]
  readonly hasMore: boolean
}

export interface ActivitySummary {
  /** Distinct accounts; shares are not identities, so they never count here. */
  readonly users: number
  readonly visits: number
  readonly sharedVisits: number
  /** Page views received in the period. */
  readonly pageViews: number
}

export interface ActivityCalendarInput {
  readonly projectId: string
  readonly userId: string
  readonly from: Date
  readonly to: Date
}

/** One UTC day with activity. A visit across midnight counts on both days. */
export interface ActivityDay {
  /** `YYYY-MM-DD`, in UTC. */
  readonly day: string
  readonly visits: number
  readonly pageViews: number
}

export interface ReadActivityVisitInput {
  readonly projectId: string
  readonly id: string
  readonly afterSequence: number
  readonly limit: number
}

export interface ActivityVisitPage {
  readonly visit: ActivityVisit
  readonly pageViews: readonly ActivityPageView[]
  readonly hasMore: boolean
}

/** A visit as core reads it, with the session it belongs to. `sixb.activity` never returns it. */
export interface StoredActivityVisitPage extends ActivityVisitPage {
  readonly sessionId: string
}

export interface ListActivitySessionVisitsInput {
  readonly projectId: string
  readonly userId: string
  /** The account's `SessionRecord` ids. */
  readonly sessionIds: readonly string[]
  /** Latest visits kept per session. */
  readonly limit: number
}

export interface ActivitySessionVisits {
  readonly sessionId: string
  /** Every visit the session opened. */
  readonly visits: number
  /** Its latest visits by start, newest first, at most `limit`. */
  readonly latest: readonly ActivityVisit[]
}

export interface ActivityStorage {
  /**
   * Assigns the visit, deduplicates and counts the session's quota atomically, including across API
   * replicas. Participates in the storage transaction it runs in.
   */
  append(input: AppendActivityInput): Promise<AppendActivityResult>
  list(input: ListActivityVisitsInput): Promise<ActivityVisitsPage>
  users(input: ListActivityUsersInput): Promise<ActivityUsersPage>
  summarize(input: ActivityPeriodInput): Promise<ActivitySummary>
  calendar(input: ActivityCalendarInput): Promise<readonly ActivityDay[]>
  read(input: ReadActivityVisitInput): Promise<StoredActivityVisitPage | null>
  /** The visits of these sessions of one account. A session without any is omitted. */
  sessionVisits(input: ListActivitySessionVisitsInput): Promise<readonly ActivitySessionVisits[]>
}
