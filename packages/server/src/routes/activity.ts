import {
  type ActivityConnection,
  type ActivityTimelineEntry,
  type ActivityVisitTimeline,
  type ActivityVisitView,
  AuthorizationError,
  type SixbHostView,
} from "@sixb/core"
import { getActivityCaptureRuntime } from "@sixb/core/internal/runtime"
import type { Elysia } from "elysia"
import { accessTokenSecurityRequirement, credentialTransport } from "../auth/access-token-boundary"
import { requestCaller, requireRequestSixb } from "../auth/scope"
import {
  SIXB_SESSION_MUTATION_SECURITY_REQUIREMENT,
  SIXB_SESSION_SECURITY_REQUIREMENT,
  SIXB_SHARED_MUTATION_SECURITY_REQUIREMENT,
  SIXB_SHARED_READ_SECURITY_REQUIREMENT,
} from "../openapi/security"
import { OPENAPI_TAGS } from "../openapi/tags"
import {
  ActivityCalendarQuerySchema,
  ActivityCalendarSchema,
  ActivityCaptureOptionsSchema,
  ActivityCaptureResultSchema,
  ActivityConnectionsPageSchema,
  ActivityConnectionsQuerySchema,
  ActivityPageQuerySchema,
  ActivityPeriodQuerySchema,
  ActivitySummarySchema,
  ActivityUsersPageSchema,
  ActivityVisitPageSchema,
  ActivityVisitParamsSchema,
  ActivityVisitQuerySchema,
  ActivityVisitsPageSchema,
  ActivityVisitTimelineSchema,
  CaptureActivityBodySchema,
} from "../schemas/activity"
import { ErrorResponseSchema } from "../schemas/common"
import { handleRouteError } from "../utils/http"

const errors = { 400: ErrorResponseSchema, 403: ErrorResponseSchema }

/**
 * Recording and reading take different authority: a browser session records only its own visits,
 * and reading needs `can.observe(project.activity)`.
 */
export function registerActivityRoutes(app: Elysia, _host: SixbHostView) {
  app.get(
    "/api/activity/capture-config",
    (context) => {
      try {
        assertBrowserCapture(context)
        return getActivityCaptureRuntime(requireRequestSixb(context)).captureOptions()
      } catch (error) {
        return handleRouteError(error, context.set)
      }
    },
    {
      response: { 200: ActivityCaptureOptionsSchema, ...errors },
      detail: {
        summary: "Read whether this browser session records activity",
        description: "A browser or shared-link session only; a native client's session gets 403.",
        tags: [OPENAPI_TAGS.activity.name],
        operationId: "getActivityCaptureConfig",
        security: [...SIXB_SESSION_SECURITY_REQUIREMENT, SIXB_SHARED_READ_SECURITY_REQUIREMENT],
      },
    }
  )

  app.post(
    "/api/activity/events",
    async (context) => {
      try {
        assertBrowserCapture(context)
        const capture = getActivityCaptureRuntime(requireRequestSixb(context))
        const result = await capture.capture(context.body.events)

        if (result.status === "throttled") {
          context.set.status = 429
          context.set.headers["retry-after"] = "60"
        }
        return result
      } catch (error) {
        return handleRouteError(error, context.set)
      }
    },
    {
      body: CaptureActivityBodySchema,
      response: { 200: ActivityCaptureResultSchema, 429: ActivityCaptureResultSchema, ...errors },
      detail: {
        summary: "Record page views and activity for this browser session",
        description:
          "A browser or shared-link session only; a native client's session gets 403. The visit belongs to the calling session.",
        tags: [OPENAPI_TAGS.activity.name],
        operationId: "captureActivity",
        security: [
          ...SIXB_SESSION_MUTATION_SECURITY_REQUIREMENT,
          SIXB_SHARED_MUTATION_SECURITY_REQUIREMENT,
        ],
      },
    }
  )

  app.get(
    "/api/activity/visits",
    async (context) => {
      try {
        const page = await requireRequestSixb(context).activity.list(pageQuery(context.query))
        return { visits: page.visits.map(serializeVisit), hasMore: page.hasMore }
      } catch (error) {
        return handleRouteError(error, context.set)
      }
    },
    {
      query: ActivityPageQuerySchema,
      response: { 200: ActivityVisitsPageSchema, ...errors },
      detail: {
        summary: "List the visits active in a period",
        tags: [OPENAPI_TAGS.activity.name],
        operationId: "listActivityVisits",
        security: accessTokenSecurityRequirement("listActivityVisits"),
      },
    }
  )

  app.get(
    "/api/activity/users",
    async (context) => {
      try {
        const page = await requireRequestSixb(context).activity.users(pageQuery(context.query))
        return {
          users: page.users.map((user) => ({ ...user, lastSeenAt: user.lastSeenAt.toISOString() })),
          hasMore: page.hasMore,
        }
      } catch (error) {
        return handleRouteError(error, context.set)
      }
    },
    {
      query: ActivityPageQuerySchema,
      response: { 200: ActivityUsersPageSchema, ...errors },
      detail: {
        summary: "List the signed-in users active in a period",
        tags: [OPENAPI_TAGS.activity.name],
        operationId: "listActivityUsers",
        security: accessTokenSecurityRequirement("listActivityUsers"),
      },
    }
  )

  app.get(
    "/api/activity/summary",
    async (context) => {
      try {
        return await requireRequestSixb(context).activity.summarize({
          from: new Date(context.query.from),
          to: new Date(context.query.to),
          userId: context.query.userId,
        })
      } catch (error) {
        return handleRouteError(error, context.set)
      }
    },
    {
      query: ActivityPeriodQuerySchema,
      response: { 200: ActivitySummarySchema, ...errors },
      detail: {
        summary: "Count the users, visits and page views of a period",
        tags: [OPENAPI_TAGS.activity.name],
        operationId: "getActivitySummary",
        security: accessTokenSecurityRequirement("getActivitySummary"),
      },
    }
  )

  app.get(
    "/api/activity/calendar",
    async (context) => {
      try {
        const calendar = await requireRequestSixb(context).activity.calendar(context.query)
        return { ...calendar, days: [...calendar.days] }
      } catch (error) {
        return handleRouteError(error, context.set)
      }
    },
    {
      query: ActivityCalendarQuerySchema,
      response: { 200: ActivityCalendarSchema, ...errors },
      detail: {
        summary: "Read a user's active days in a UTC year",
        tags: [OPENAPI_TAGS.activity.name],
        operationId: "getActivityCalendar",
        security: accessTokenSecurityRequirement("getActivityCalendar"),
      },
    }
  )

  app.get(
    "/api/activity/visits/:visitId",
    async (context) => {
      try {
        const page = await requireRequestSixb(context).activity.read(
          context.params.visitId,
          context.query
        )
        if (!page) {
          context.set.status = 404
          return { error: "Activity visit not found" }
        }

        return {
          visit: serializeVisit(page.visit),
          pageViews: page.pageViews.map((pageView) => ({
            id: pageView.id,
            sequence: pageView.sequence,
            route: pageView.route,
            receivedAt: pageView.receivedAt.toISOString(),
          })),
          hasMore: page.hasMore,
        }
      } catch (error) {
        return handleRouteError(error, context.set)
      }
    },
    {
      params: ActivityVisitParamsSchema,
      query: ActivityVisitQuerySchema,
      response: { 200: ActivityVisitPageSchema, 404: ErrorResponseSchema, ...errors },
      detail: {
        summary: "Read the page views of one visit",
        tags: [OPENAPI_TAGS.activity.name],
        operationId: "getActivityVisit",
        security: accessTokenSecurityRequirement("getActivityVisit"),
      },
    }
  )

  app.get(
    "/api/activity/visits/:visitId/timeline",
    async (context) => {
      try {
        const timeline = await requireRequestSixb(context).activity.timeline(context.params.visitId)
        if (!timeline) {
          context.set.status = 404
          return { error: "Activity visit not found" }
        }

        return serializeTimeline(timeline)
      } catch (error) {
        return handleRouteError(error, context.set)
      }
    },
    {
      params: ActivityVisitParamsSchema,
      response: { 200: ActivityVisitTimelineSchema, 404: ErrorResponseSchema, ...errors },
      detail: {
        summary: "Read what one visit did",
        description:
          "Its page views, with the actions, workflows and Agent runs its session started, and the connection it came through. At most 200 page views and 200 recorded executions: see truncated.",
        tags: [OPENAPI_TAGS.activity.name],
        operationId: "getActivityVisitTimeline",
        security: accessTokenSecurityRequirement("getActivityVisitTimeline"),
      },
    }
  )

  app.get(
    "/api/activity/connections",
    async (context) => {
      try {
        const page = await requireRequestSixb(context).activity.connections(context.query)
        return {
          connections: page.connections.map((connection) => ({
            ...serializeConnection(connection),
            latestVisits: connection.latestVisits.map(serializeVisit),
          })),
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        }
      } catch (error) {
        return handleRouteError(error, context.set)
      }
    },
    {
      query: ActivityConnectionsQuerySchema,
      response: { 200: ActivityConnectionsPageSchema, ...errors },
      detail: {
        summary: "List a user's sign-ins with the visits each opened",
        description: "Newest first, revoked and expired sessions included.",
        tags: [OPENAPI_TAGS.activity.name],
        operationId: "listActivityConnections",
        security: accessTokenSecurityRequirement("listActivityConnections"),
      },
    }
  )

  return app
}

function pageQuery(query: {
  readonly from: string
  readonly to: string
  readonly userId?: string
  readonly limit?: number
  readonly beforeAt?: string
  readonly beforeId?: string
}) {
  return {
    from: new Date(query.from),
    to: new Date(query.to),
    userId: query.userId,
    limit: query.limit,
    before:
      query.beforeAt !== undefined && query.beforeId !== undefined
        ? { at: new Date(query.beforeAt), id: query.beforeId }
        : undefined,
  }
}

function serializeVisit(visit: ActivityVisitView) {
  return {
    ...visit,
    startedAt: visit.startedAt.toISOString(),
    lastSeenAt: visit.lastSeenAt.toISOString(),
  }
}

function serializeTimeline(timeline: ActivityVisitTimeline) {
  return {
    visit: serializeVisit(timeline.visit),
    ...(timeline.connection ? { connection: serializeConnection(timeline.connection) } : {}),
    entries: timeline.entries.map(serializeEntry),
    truncated: timeline.truncated,
  }
}

function serializeEntry(entry: ActivityTimelineEntry) {
  const at = entry.at.toISOString()
  if (entry.kind !== "agent") {
    return { ...entry, at }
  }

  const { cost, ...run } = entry
  return { ...run, at, ...(cost ? { cost: { ...cost, amounts: [...cost.amounts] } } : {}) }
}

function serializeConnection<T extends ActivityConnection>(connection: T) {
  return {
    ...connection,
    createdAt: connection.createdAt.toISOString(),
    ...(connection.type === "session" && connection.lastSeenAt
      ? { lastSeenAt: connection.lastSeenAt.toISOString() }
      : {}),
    ...(connection.revokedAt ? { revokedAt: connection.revokedAt.toISOString() } : {}),
  }
}

/**
 * A signed-in browser records through its cookie. A native client's bearer session is not a
 * visit; a shared-link session has no caller here and is checked by the runtime.
 */
function assertBrowserCapture(context: unknown): void {
  const caller = requestCaller(context)
  if (caller && credentialTransport(caller) !== "cookie") {
    throw new AuthorizationError(
      "activity.capture",
      "[SixbServer] Activity is recorded only through a browser or shared-link session."
    )
  }
}
