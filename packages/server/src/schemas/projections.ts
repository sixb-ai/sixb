import { z } from "zod"

export const ProjectionKindSchema = z.enum(["object", "link", "telemetry"])
export const ProjectionRunStatusSchema = z.enum(["running", "succeeded", "failed", "cancelled"])

export const ProjectionRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectionId: z.string(),
  projectionKind: ProjectionKindSchema,
  datasetId: z.string(),
  datasetVersionId: z.string(),
  objectTypeId: z.string().optional(),
  sourceObjectTypeId: z.string().optional(),
  targetObjectTypeId: z.string().optional(),
  status: ProjectionRunStatusSchema,
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  errorMessage: z.string().optional(),
  rowsProcessed: z.number(),
  rowsSkipped: z.number(),
  objectsUpserted: z.number(),
  linksUpserted: z.number(),
  telemetryPointsAppended: z.number(),
  telemetryPointsSkipped: z.number(),
  telemetryRowsFailed: z.number(),
})

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
  latestRun: ProjectionRunSchema.nullable(),
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
  latestRun: ProjectionRunSchema.nullable(),
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
  latestRun: ProjectionRunSchema.nullable(),
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

export const ProjectionRunParamsSchema = z.object({
  runId: z.string().min(1),
})

export const ProjectionRunsQuerySchema = z.object({
  projectionId: z.string().optional(),
  projectionKind: ProjectionKindSchema.optional(),
  datasetId: z.string().optional(),
  datasetVersionId: z.string().optional(),
  status: ProjectionRunStatusSchema.optional(),
  startedAfter: z.string().optional(),
  startedBefore: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
  order: z.enum(["asc", "desc"]).optional(),
})

export const ProjectionRunListResponseSchema = z.object({
  runs: z.array(ProjectionRunSchema),
  hasMore: z.boolean(),
  total: z.number(),
})
