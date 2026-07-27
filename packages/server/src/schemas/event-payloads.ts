import type { DomainEvent } from "@sixb/core"
import { z } from "zod"
import { JsonNullSchema, JsonValueSchema } from "./common"

const PropertyChangeSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("created"), after: JsonValueSchema }),
  z.object({
    operation: z.literal("updated"),
    before: JsonValueSchema,
    after: JsonValueSchema,
  }),
  z.object({
    operation: z.literal("cleared"),
    before: JsonValueSchema,
    after: JsonNullSchema,
  }),
])

const PropertyChangesSchema = z.record(PropertyChangeSchema)
const ObjectMutationPayloadSchema = z.object({
  objectTypeId: z.string(),
  primaryId: z.string(),
  properties: z.record(JsonValueSchema),
  propertyChanges: PropertyChangesSchema,
})
const ObjectDeletedPayloadSchema = z.object({
  objectTypeId: z.string(),
  primaryId: z.string(),
  propertyChanges: PropertyChangesSchema,
})
const LinkSubjectSchema = z.object({
  sourceTypeId: z.string(),
  sourceId: z.string(),
  linkId: z.string(),
  targetTypeId: z.string(),
  targetId: z.string(),
})
const LinkMutationPayloadSchema = LinkSubjectSchema.extend({
  properties: z.record(JsonValueSchema).optional(),
  propertyChanges: PropertyChangesSchema,
})
const LinkDeletedPayloadSchema = LinkSubjectSchema.extend({
  propertyChanges: PropertyChangesSchema,
})

type OntologyEventType =
  | "object.created"
  | "object.updated"
  | "object.deleted"
  | "link.created"
  | "link.updated"
  | "link.deleted"
  | "telemetry.appended"

type OntologyEventPayloadSchemas = {
  readonly [TType in OntologyEventType]: z.ZodType<
    Extract<DomainEvent, { readonly type: TType }>["payload"],
    z.ZodTypeDef,
    unknown
  >
}

/** Exact public payload shapes for authoritative ontology facts. */
export const ONTOLOGY_EVENT_PAYLOAD_SCHEMAS = {
  "object.created": ObjectMutationPayloadSchema,
  "object.updated": ObjectMutationPayloadSchema,
  "object.deleted": ObjectDeletedPayloadSchema,
  "link.created": LinkMutationPayloadSchema,
  "link.updated": LinkMutationPayloadSchema,
  "link.deleted": LinkDeletedPayloadSchema,
  "telemetry.appended": z.object({
    objectTypeId: z.string(),
    objectId: z.string(),
    propertyId: z.string(),
    value: JsonValueSchema,
    unit: z.string().optional(),
    at: z.string(),
  }),
} satisfies OntologyEventPayloadSchemas
