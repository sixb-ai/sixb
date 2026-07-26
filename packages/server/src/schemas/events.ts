import type { DomainEvent } from "@sixb/core"
import {
  EVENT_TOPICS as CORE_EVENT_TOPICS,
  EVENT_TYPES as CORE_EVENT_TYPES,
  EVENT_DEFINITIONS,
  isOntologyFactType,
} from "@sixb/core/internal/events"
import { z } from "zod"
import { JsonValueSchema } from "./common"
import { ONTOLOGY_EVENT_PAYLOAD_SCHEMAS } from "./event-payloads"

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

const StoredEventBaseSchema = z.object({
  id: z.string(),
  cursor: z.string(),
  schemaVersion: z.literal(1),
  projectId: z.string(),
  occurredAt: z.string(),
  actor: z
    .object({
      type: z.enum(["user", "service", "system"]),
      id: z.string(),
    })
    .optional(),
  partitionKey: z.string(),
})

const StoredAuthorableEventBaseSchema = StoredEventBaseSchema.extend({
  correlationId: z.string().optional(),
  causationId: z.string().optional(),
  idempotencyKey: z.string().optional(),
  origin: EventOriginSchema.optional(),
  metadata: z.record(JsonValueSchema).optional(),
})

const StoredOntologyEventBaseSchema = StoredEventBaseSchema.extend({
  origin: EventOriginSchema,
  commitId: z.string(),
  commitOrdinal: z.number().int().nonnegative(),
})

const ontologyEventTypes = EVENT_TYPES.filter(isOntologyFactType)
const ontologyEventSchemas = ontologyEventTypes.map((type) =>
  StoredOntologyEventBaseSchema.extend({
    type: z.literal(type),
    topic: z.literal(EVENT_DEFINITIONS[type].topic),
    payload: ONTOLOGY_EVENT_PAYLOAD_SCHEMAS[type],
  })
)
const authorableEventTypes = EVENT_TYPES.filter(
  (type) => !isOntologyFactType(type)
) as unknown as readonly [
  Exclude<DomainEvent["type"], (typeof ontologyEventTypes)[number]>,
  ...Exclude<DomainEvent["type"], (typeof ontologyEventTypes)[number]>[],
]

const StoredAuthorableEventSchema = StoredAuthorableEventBaseSchema.extend({
  type: z.enum(authorableEventTypes),
  topic: EventTopicSchema,
  payload: z.record(z.unknown()),
})

type EventSchemaOption = z.ZodDiscriminatedUnionOption<"type">
const StoredOntologyEventSchema = z.discriminatedUnion(
  "type",
  ontologyEventSchemas as unknown as [EventSchemaOption, EventSchemaOption, ...EventSchemaOption[]]
)
export const EventSchema = z.union([StoredOntologyEventSchema, StoredAuthorableEventSchema])

export const EventsResponseSchema = z.object({
  count: z.number(),
  events: z.array(EventSchema),
})
