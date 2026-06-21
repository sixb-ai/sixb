import { z } from "zod"

export const ForeignKeyDescriptorSchema = z.object({
  linkId: z.string(),
  sourcePropertyId: z.string().optional(),
  sourceField: z.string().optional(),
  targetObjectTypeId: z.string(),
})

export const ObjectProjectionSchema = z.object({
  _tag: z.literal("ObjectProjectionDefinition"),
  id: z.string(),
  objectTypeId: z.string(),
  datasetId: z.string(),
  properties: z.record(z.string()),
  links: z.record(ForeignKeyDescriptorSchema),
})

export const LinkProjectionSchema = z.object({
  _tag: z.literal("LinkProjectionDefinition"),
  id: z.string(),
  linkId: z.string(),
  sourceObjectTypeId: z.string(),
  targetObjectTypeId: z.string(),
  datasetId: z.string(),
  sourceField: z.string(),
  targetField: z.string(),
})

export const TelemetryProjectionSchema = z.object({
  _tag: z.literal("TelemetryProjectionDefinition"),
  id: z.string(),
  objectTypeId: z.string(),
  propertyId: z.string(),
  datasetId: z.string(),
  objectIdField: z.string(),
  atField: z.string(),
  valueField: z.string(),
  unitField: z.string().optional(),
})

export const ProjectionListResponseSchema = z.object({
  objectProjections: z.array(ObjectProjectionSchema),
  linkProjections: z.array(LinkProjectionSchema),
  telemetryProjections: z.array(TelemetryProjectionSchema),
})

export const ProjectionParamsSchema = z.object({
  projectionId: z.string().min(1),
})

export const ProjectionResponseSchema = z.union([
  ObjectProjectionSchema,
  LinkProjectionSchema,
  TelemetryProjectionSchema,
])
