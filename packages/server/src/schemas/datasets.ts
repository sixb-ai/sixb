import { z } from "zod"
import { RedactionsSchema } from "./common"

export const DatasetParamsSchema = z.object({
  datasetId: z.string().min(1),
})

export const DatasetVersionParamsSchema = DatasetParamsSchema.extend({
  versionId: z.string().min(1),
})

export const DatasetVersionsQuerySchema = z.object({
  limit: z.string().optional(),
})

/**
 * Elysia's query parser splits any comma-separated value into an array before validation, and
 * pushes a repeated key's value into the existing array as-is. `?columns=id`, `?columns=id,title`,
 * `?columns=id&columns=title` and `?columns=x&columns=id,title` therefore arrive as a string, a
 * flat array, a flat array, and a nested array. All of them name the same thing: a column list.
 */
const QueryStringListSchema = z.preprocess(flattenQueryStringList, z.array(z.string()))

function flattenQueryStringList(value: unknown): unknown {
  if (typeof value !== "string" && !Array.isArray(value)) return value
  const items = [value].flat(Number.POSITIVE_INFINITY)
  if (!items.every((item) => typeof item === "string")) return value
  return items
    .flatMap((item) => item.split(","))
    .map((item) => item.trim())
    .filter(Boolean)
}

export const DatasetRowsQuerySchema = z.object({
  versionId: z.string().optional(),
  columns: QueryStringListSchema.optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
})

export const DatasetColumnSchema = z.object({
  name: z.string(),
  type: z.enum([
    "string",
    "boolean",
    "int64",
    "float64",
    "decimal",
    "date",
    "timestamp",
    "json",
    "fileRef",
  ]),
  nullable: z.boolean().optional(),
})

export const DatasetSchema = z.object({
  columns: z.array(DatasetColumnSchema),
})

export const DatasetDefinitionSchema = z.object({
  id: z.string(),
  description: z.string().optional(),
  primaryKey: z.union([z.string(), z.array(z.string()).min(2)]).optional(),
  sequenceBy: z.string().optional(),
  partitionBy: z.array(z.string()).optional(),
  schema: DatasetSchema,
})

export const DatasetVersionRefSchema = z.object({
  datasetId: z.string(),
  versionId: z.string(),
})

export const DatasetProducerSchema = z.object({
  kind: z.enum(["sync", "pipeline", "ingest"]),
  id: z.string().optional(),
  runId: z.string().optional(),
})

export const DatasetVersionSchema = z.object({
  datasetId: z.string(),
  versionId: z.string(),
  parentVersionId: z.string().optional(),
  mode: z.enum(["snapshot", "append", "merge", "schema"]),
  createdAt: z.string(),
  schema: DatasetSchema,
  producer: DatasetProducerSchema.optional(),
  inputs: z.array(DatasetVersionRefSchema).optional(),
  rowCount: z.number().optional(),
  sizeBytes: z.number().optional(),
})

export const DatasetLatestVersionSummarySchema = z.object({
  datasetId: z.string(),
  versionId: z.string(),
  mode: z.enum(["snapshot", "append", "merge", "schema"]),
  createdAt: z.string(),
  rowCount: z.number().optional(),
})

export const DatasetCatalogItemSchema = DatasetDefinitionSchema.extend({
  kind: z.literal("dataset"),
  materialized: z.boolean(),
  latestVersion: DatasetLatestVersionSummarySchema.nullable(),
  syncIds: z.array(z.string()),
  sourcePipelineIds: z.array(z.string()),
  targetPipelineIds: z.array(z.string()),
  projectionIds: z.array(z.string()),
})

export const DatasetVersionListResponseSchema = z.object({
  versions: z.array(DatasetVersionSchema),
  count: z.number(),
})

export const DatasetRowsResponseSchema = z.object({
  datasetId: z.string(),
  versionId: z.string(),
  version: DatasetVersionSchema,
  /** Returned columns. Redacted columns are left out. */
  columns: z.array(z.string()),
  /** Columns omitted because the caller lacks a clearance for their markings. */
  redactions: RedactionsSchema.optional(),
  rows: z.array(z.record(z.unknown())),
  count: z.number(),
  limit: z.number(),
  offset: z.number(),
  total: z.number().optional(),
  hasMore: z.boolean(),
})
