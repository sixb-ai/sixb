import {
  ACTIVITY_BATCH_LIMIT,
  ACTIVITY_EVENT_ID_PATTERN,
  ACTIVITY_HOSTNAME_PATTERN,
  ACTIVITY_ID_MAX_LENGTH,
  ACTIVITY_LABEL_MAX_LENGTH,
  ACTIVITY_LABEL_PATTERN,
  ACTIVITY_MAX_PAGE_SIZE,
  ACTIVITY_MAX_PERIOD_MS,
  ACTIVITY_REFERRER_MAX_LENGTH,
  ACTIVITY_ROUTE_MAX_LENGTH,
  ACTIVITY_VISIT_ID_PATTERN,
  isActivityRoutePattern,
} from "@sixb/core/internal/storage"
import { z } from "zod"
import { ActionRunStatusSchema } from "./actions"
import { AgentRunStatusSchema } from "./agents"
import { AiCostSummarySchema } from "./ai-accounting"
import { WorkflowRunStatusSchema } from "./workflows"

// The limits come from the activity policy, so the API refuses what the providers would.
const VisitIdSchema = z.string().regex(ACTIVITY_VISIT_ID_PATTERN)

const UserIdSchema = z
  .string()
  .min(1)
  .max(ACTIVITY_ID_MAX_LENGTH)
  .refine((value) => value.trim().length > 0, "Expected a user id")

const RouteSchema = z
  .string()
  .min(1)
  .max(ACTIVITY_ROUTE_MAX_LENGTH)
  .startsWith("/")
  .refine(isActivityRoutePattern, "Expected a normalized route pattern")

const LabelSchema = z
  .string()
  .min(1)
  .max(ACTIVITY_LABEL_MAX_LENGTH)
  .regex(ACTIVITY_LABEL_PATTERN)
  .refine((value) => value === value.trim(), "Expected a trimmed label")

const ActivityAttributionSchema = z
  .object({
    source: LabelSchema.optional(),
    medium: LabelSchema.optional(),
    campaign: LabelSchema.optional(),
    referrer: z
      .string()
      .min(1)
      .max(ACTIVITY_REFERRER_MAX_LENGTH)
      .regex(ACTIVITY_HOSTNAME_PATTERN)
      .optional(),
  })
  .strict()

export const ActivityEventInputSchema = z
  .object({
    id: z.string().regex(ACTIVITY_EVENT_ID_PATTERN),
    type: z.enum(["page.view", "visit.activity"]),
    route: RouteSchema,
    attribution: ActivityAttributionSchema.optional(),
  })
  .strict()

export const CaptureActivityBodySchema = z
  .object({ events: z.array(ActivityEventInputSchema).min(1).max(ACTIVITY_BATCH_LIMIT) })
  .strict()
  .refine(
    (body) => new Set(body.events.map((event) => event.id)).size === body.events.length,
    "Event ids must be unique"
  )

export const ActivityCaptureOptionsSchema = z.object({
  enabled: z.boolean(),
  idleTimeoutMs: z.number(),
})

export const ActivityCaptureResultSchema = z.object({
  status: z.enum(["accepted", "disabled", "throttled"]),
  accepted: z.number(),
})

const ActivityActorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), userId: z.string() }),
  z.object({
    type: z.literal("share"),
    grantId: z.string(),
    definitionId: z.string().optional(),
  }),
])

const ActivityVisitSchema = z.object({
  id: VisitIdSchema,
  actor: ActivityActorSchema,
  attribution: ActivityAttributionSchema.nullable(),
  startedAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  pageViews: z.number(),
})

export const ActivityVisitsPageSchema = z.object({
  visits: z.array(ActivityVisitSchema),
  hasMore: z.boolean(),
})

export const ActivityUsersPageSchema = z.object({
  users: z.array(
    z.object({
      userId: z.string(),
      displayName: z.string().optional(),
      lastSeenAt: z.string().datetime(),
      visits: z.number(),
      pageViews: z.number(),
    })
  ),
  hasMore: z.boolean(),
})

export const ActivitySummarySchema = z.object({
  users: z.number(),
  visits: z.number(),
  sharedVisits: z.number(),
  pageViews: z.number(),
})

const ActivityConnectionStatusSchema = z.enum(["active", "expired", "revoked"])

const ActivitySessionConnectionSchema = z.object({
  type: z.literal("session"),
  device: z.object({ browser: z.string().optional(), os: z.string().optional() }),
  clientName: z.string().optional(),
  status: ActivityConnectionStatusSchema,
  createdAt: z.string().datetime(),
  lastSeenAt: z.string().datetime().optional(),
  revokedAt: z.string().datetime().optional(),
})

const ActivityShareConnectionSchema = z.object({
  type: z.literal("share"),
  grantId: z.string(),
  definitionId: z.string().optional(),
  status: ActivityConnectionStatusSchema,
  createdAt: z.string().datetime(),
  revokedAt: z.string().datetime().optional(),
})

const ActivityTimelineEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("page"),
    at: z.string().datetime(),
    sequence: z.number(),
    route: z.string(),
  }),
  z.object({
    kind: z.literal("action"),
    at: z.string().datetime(),
    executionId: z.string(),
    actionId: z.string(),
    runId: z.string(),
    status: z.union([ActionRunStatusSchema, z.literal("incomplete")]),
    runVisible: z.boolean().describe("Whether the viewer may read the run itself."),
    object: z.object({ objectTypeId: z.string(), primaryId: z.string() }).optional(),
  }),
  z.object({
    kind: z.literal("workflow"),
    at: z.string().datetime(),
    executionId: z.string(),
    workflowId: z.string(),
    runId: z.string(),
    status: z.union([WorkflowRunStatusSchema, z.literal("incomplete")]),
    runVisible: z.boolean().describe("Whether the viewer may read the run itself."),
  }),
  z.object({
    kind: z.literal("agent"),
    at: z.string().datetime(),
    executionId: z.string(),
    runId: z.string(),
    threadId: z.string(),
    status: AgentRunStatusSchema,
    messages: z.number(),
    cost: AiCostSummarySchema.optional(),
  }),
])

export const ActivityVisitTimelineSchema = z.object({
  visit: ActivityVisitSchema,
  connection: z
    .discriminatedUnion("type", [ActivitySessionConnectionSchema, ActivityShareConnectionSchema])
    .optional(),
  entries: z.array(ActivityTimelineEntrySchema),
  truncated: z.boolean(),
})

export const ActivityConnectionsPageSchema = z.object({
  connections: z.array(
    ActivitySessionConnectionSchema.extend({
      visits: z.number(),
      latestVisits: z.array(ActivityVisitSchema),
    })
  ),
  nextCursor: z.string().optional(),
})

export const ActivityCalendarSchema = z.object({
  userId: z.string(),
  year: z.number(),
  days: z.array(z.object({ day: z.string(), visits: z.number(), pageViews: z.number() })),
})

const periodFields = {
  from: z.string().datetime(),
  to: z.string().datetime(),
  userId: UserIdSchema.optional(),
}

const PageSizeSchema = z.coerce.number().int().min(1).max(ACTIVITY_MAX_PAGE_SIZE)

const pageFields = {
  limit: PageSizeSchema.optional(),
  beforeAt: z.string().datetime().optional(),
  beforeId: z.string().min(1).max(ACTIVITY_ID_MAX_LENGTH).optional(),
}

function isBoundedPeriod(input: { readonly from: string; readonly to: string }): boolean {
  const span = Date.parse(input.to) - Date.parse(input.from)
  return span > 0 && span <= ACTIVITY_MAX_PERIOD_MS
}

function hasWholeCursor(input: { readonly beforeAt?: string; readonly beforeId?: string }) {
  return (input.beforeAt === undefined) === (input.beforeId === undefined)
}

export const ActivityPeriodQuerySchema = z
  .object(periodFields)
  .refine(isBoundedPeriod, "Expected an ordered period of at most 31 days")

export const ActivityPageQuerySchema = z
  .object({ ...periodFields, ...pageFields })
  .refine(isBoundedPeriod, "Expected an ordered period of at most 31 days")
  .refine(hasWholeCursor, "beforeAt and beforeId go together")

export const ActivityCalendarQuerySchema = z.object({
  userId: UserIdSchema,
  year: z.coerce.number().int().min(1970).max(9998),
})

export const ActivityConnectionsQuerySchema = z.object({
  userId: UserIdSchema,
  limit: PageSizeSchema.optional(),
  cursor: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional()
    .describe("The previous page's nextCursor."),
})

export const ActivityVisitParamsSchema = z.object({ visitId: VisitIdSchema })
