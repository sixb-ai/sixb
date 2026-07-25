import type { DomainEvent } from "@sixb/core"
import {
  EVENT_TOPICS as CORE_EVENT_TOPICS,
  EVENT_TYPES as CORE_EVENT_TYPES,
} from "@sixb/core/internal/events"
import { z } from "zod"

// z.enum expects a non-empty tuple; the core registry exposes readonly arrays.
export const EVENT_TOPICS = CORE_EVENT_TOPICS as readonly [
  DomainEvent["topic"],
  ...DomainEvent["topic"][],
]
export const EVENT_TYPES = CORE_EVENT_TYPES as readonly [
  DomainEvent["type"],
  ...DomainEvent["type"][],
]

export const EventTopicSchema = z.enum(EVENT_TOPICS)
export const EventTypeSchema = z.enum(EVENT_TYPES)
const ProjectionEventOriginSchema = z.object({
  kind: z.literal("projection"),
  projectionId: z.string(),
  projectionRunId: z.string(),
  datasetId: z.string(),
  datasetVersionId: z.string(),
})

/** Mirrors the Materializer's commit origin: which ingress produced the fact. */
export const EventOriginSchema = z.union([
  z.object({
    kind: z.literal("action"),
    actionId: z.string(),
    runId: z.string(),
  }),
  z.object({ kind: z.literal("runtime"), requestId: z.string() }),
  ProjectionEventOriginSchema,
  z.object({
    kind: z.literal("telemetry"),
    source: z.union([
      z.object({ kind: z.literal("runtime"), requestId: z.string() }),
      ProjectionEventOriginSchema.extend({ batchOrdinal: z.number() }),
    ]),
  }),
])

export const EventsQuerySchema = z.object({
  topic: EventTopicSchema.optional(),
  type: EventTypeSchema.optional(),
  afterCursor: z.string().optional(),
  limit: z.string().optional(),
})

export const EventSchema = z.object({
  id: z.string(),
  cursor: z.string(),
  schemaVersion: z.number(),
  projectId: z.string(),
  occurredAt: z.string(),
  correlationId: z.string().optional(),
  causationId: z.string().optional(),
  idempotencyKey: z.string().optional(),
  actor: z
    .object({
      type: z.enum(["user", "service", "system"]),
      id: z.string(),
    })
    .optional(),
  origin: EventOriginSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
  /** Present on materializer facts: the authoritative commit and its stable fact ordinal. */
  commitId: z.string().optional(),
  commitOrdinal: z.number().optional(),
  type: EventTypeSchema,
  topic: EventTopicSchema,
  partitionKey: z.string(),
  payload: z.unknown(),
})

export const EventsResponseSchema = z.object({
  count: z.number(),
  events: z.array(EventSchema),
})
