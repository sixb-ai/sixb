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
  z.object({ type: z.literal("share"), grantId: z.string() }),
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

export const ActivityVisitPageSchema = z.object({
  visit: ActivityVisitSchema,
  pageViews: z.array(
    z.object({
      id: z.string(),
      sequence: z.number(),
      route: z.string(),
      receivedAt: z.string().datetime(),
    })
  ),
  hasMore: z.boolean(),
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

export const ActivityVisitParamsSchema = z.object({ visitId: VisitIdSchema })

export const ActivityVisitQuerySchema = z.object({
  afterSequence: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  limit: PageSizeSchema.optional(),
})
