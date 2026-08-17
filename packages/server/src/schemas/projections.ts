import type { SixbFailure } from "@sixb/core"
import { PROJECTION_RUN_FAILURE_CODES, type ProjectionRunFailureCode } from "@sixb/core/storage"
import { z } from "zod"
import { sixbFailureSchema } from "./common"

const ProjectionRunFailureSchema: z.ZodType<SixbFailure<ProjectionRunFailureCode>> =
  sixbFailureSchema(PROJECTION_RUN_FAILURE_CODES)

export const ProjectionKindSchema = z.enum(["object", "link", "telemetry"])
export const ProjectionRunStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
])

const ProjectionRunIdentityBaseSchema = z.object({
  projectionId: z.string(),
  datasetVersion: z.object({
    datasetId: z.string(),
    versionId: z.string(),
    createdAt: z.string(),
  }),
  ontologyRevision: z.string(),
  projectionRevision: z.string(),
  ownershipHash: z.string(),
})

const ProjectionRunBaseSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  executionId: z.string(),
  status: ProjectionRunStatusSchema,
  attempt: z.number(),
  progress: z.object({
    sourceRowsRead: z.number(),
    sourceRowsSkipped: z.number(),
  }),
  queuedAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  error: ProjectionRunFailureSchema.optional(),
})

const ObjectProjectionRunSchema = ProjectionRunBaseSchema.extend({
  identity: ProjectionRunIdentityBaseSchema.extend({
    projectionKind: z.literal("object"),
    protocol: z.literal("replacement"),
  }),
  target: z.object({ objectTypeId: z.string() }),
})

const LinkProjectionRunSchema = ProjectionRunBaseSchema.extend({
  identity: ProjectionRunIdentityBaseSchema.extend({
    projectionKind: z.literal("link"),
    protocol: z.literal("replacement"),
  }),
  target: z.object({
    sourceObjectTypeId: z.string(),
    targetObjectTypeId: z.string(),
  }),
})

const TelemetryProjectionRunSchema = ProjectionRunBaseSchema.extend({
  identity: ProjectionRunIdentityBaseSchema.extend({
    projectionKind: z.literal("telemetry"),
    protocol: z.literal("telemetry"),
  }),
  target: z.object({ objectTypeId: z.string() }),
})

export const ProjectionRunSchema = z.union([
  ObjectProjectionRunSchema,
  LinkProjectionRunSchema,
  TelemetryProjectionRunSchema,
])

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
