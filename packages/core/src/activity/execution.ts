import { AuthorizationError, assertAuthorized } from "../authorization"
import { getAuthorizationRef } from "../execution/authorization"
import type { SixbRuntimeContext } from "../runtime/types"
import type {
  ActivityEventInput,
  ActivitySummary,
  ActivityUser,
  ActivityVisitPage,
  ActivityVisitsPage,
} from "../storage/activity/types"
import {
  type ActivityConnectionsPage,
  type ActivityConnectionsQuery,
  readActivityConnections,
} from "./connection"
import type {
  ActivityCalendar,
  ActivityCalendarQuery,
  ActivityCaptureOptions,
  ActivityCaptureResult,
  ActivityPageQuery,
  ActivityPeriodQuery,
  ActivityService,
  ActivitySource,
  ActivityTimelineQuery,
} from "./service"
import {
  ACTIVITY_TIMELINE_LIMIT,
  type ActivityVisitTimeline,
  composeActivityTimeline,
} from "./timeline"

export interface ActivityUsersResult {
  /** `displayName` is the account's profile name; no other profile field is read. */
  readonly users: readonly (ActivityUser & { readonly displayName?: string })[]
  readonly hasMore: boolean
}

/** `sixb.activity`: the app's recorded visits. Every read needs `can.observe(project.activity)`. */
export interface ActivityRuntime {
  list(query: ActivityPageQuery): Promise<ActivityVisitsPage>
  users(query: ActivityPageQuery): Promise<ActivityUsersResult>
  summarize(query: ActivityPeriodQuery): Promise<ActivitySummary>
  calendar(query: ActivityCalendarQuery): Promise<ActivityCalendar>
  read(visitId: string, query?: ActivityTimelineQuery): Promise<ActivityVisitPage | null>
  /**
   * The visit's page views with the actions, workflows and Agent runs its session started, and
   * the connection it came through. Bounded: see `truncated`.
   */
  timeline(visitId: string): Promise<ActivityVisitTimeline | null>
  /** A user's sign-ins, newest first, with the visits each opened. */
  connections(query: ActivityConnectionsQuery): Promise<ActivityConnectionsPage>
}

/**
 * Recording, for the server's capture route only: it is not on `sixb.activity`, so project code
 * cannot record visits under whatever authority it runs with.
 */
export interface ActivityCaptureRuntime {
  /** The settings a browser session reads before it sends anything. */
  captureOptions(): ActivityCaptureOptions
  /** Records a batch for the calling user or shared session. */
  capture(events: readonly ActivityEventInput[]): Promise<ActivityCaptureResult>
}

// Display names are read one account at a time; a page of users reads a few at once.
const PROFILE_READ_CONCURRENCY = 8

export function createActivityRuntime(
  runtime: SixbRuntimeContext,
  service: ActivityService
): ActivityRuntime {
  const assertObservable = () => assertAuthorized(runtime, { kind: "activity.observe" })

  return {
    async list(query) {
      assertObservable()
      return service.list(query)
    },

    async users(query) {
      assertObservable()
      const page = await service.users(query)

      // Only accounts in this bounded page are looked up, and only their name is kept.
      const users = await mapInChunks(page.users, PROFILE_READ_CONCURRENCY, async (user) => {
        const profile = await runtime.storage.auth?.users.getById({
          projectId: runtime.projectId,
          id: user.userId,
        })
        return profile?.displayName ? { ...user, displayName: profile.displayName } : user
      })

      return { users, hasMore: page.hasMore }
    },

    async summarize(query) {
      assertObservable()
      return service.summarize(query)
    },

    async calendar(query) {
      assertObservable()
      return service.calendar(query)
    },

    async read(visitId, query) {
      assertObservable()
      return service.read(visitId, query)
    },

    async timeline(visitId) {
      assertObservable()
      const page = await service.readWithSession({ id: visitId, limit: ACTIVITY_TIMELINE_LIMIT })
      return page ? composeActivityTimeline(runtime, page, new Date()) : null
    },

    async connections(query) {
      assertObservable()
      return readActivityConnections(runtime, service, query, new Date())
    },
  }
}

export function createActivityCaptureRuntime(
  runtime: SixbRuntimeContext,
  service: ActivityService
): ActivityCaptureRuntime {
  return {
    captureOptions() {
      captureSource(runtime)
      return service.captureOptions
    },

    async capture(events) {
      return service.capture(captureSource(runtime), events)
    },
  }
}

const activityCaptureKey: unique symbol = Symbol("sixb.activityCapture")

interface ActivityCaptureOwner {
  readonly [activityCaptureKey]?: ActivityCaptureRuntime
}

export function registerActivityCaptureRuntime(
  owner: object,
  capture: ActivityCaptureRuntime
): void {
  Object.defineProperty(owner, activityCaptureKey, {
    configurable: false,
    enumerable: false,
    value: capture,
    writable: false,
  })
}

/** The recording side of a bound SDK, such as a request's. */
export function getActivityCaptureRuntime(owner: object): ActivityCaptureRuntime {
  const capture = (owner as ActivityCaptureOwner)[activityCaptureKey]
  if (!capture) {
    throw new Error("[Sixb] Activity capture is not registered for this execution.")
  }
  return capture
}

/**
 * The session the batch came through, from verified authorization only. A browser never names an
 * actor, and an access token or a trusted primitive is not a visit.
 */
function captureSource(runtime: SixbRuntimeContext): ActivitySource {
  const ref = getAuthorizationRef(runtime.runtimeAuthorization)

  if (
    ref.type === "principal" &&
    ref.principal.type === "user" &&
    ref.credential?.type === "session"
  ) {
    return {
      actor: { type: "user", userId: ref.principal.id },
      sessionId: ref.credential.id,
    }
  }

  if (ref.type === "delegated") {
    return {
      actor: { type: "share", grantId: ref.delegation.grantId },
      sessionId: ref.delegation.sessionId,
    }
  }

  throw new AuthorizationError(
    "activity.capture",
    "[Sixb] Activity is recorded only for a signed-in user's session or a shared link's session."
  )
}

async function mapInChunks<T, R>(
  items: readonly T[],
  size: number,
  map: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  for (let start = 0; start < items.length; start += size) {
    const chunk = await Promise.all(items.slice(start, start + size).map(map))
    results.push(...chunk)
  }
  return results
}
