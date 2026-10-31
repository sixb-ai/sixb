import { z } from "zod"
import { JsonValueSchema } from "./common"
import { DatasetColumnRefSchema, DatasetVersionRefSchema } from "./datasets"
import { EventExecutorSchema } from "./events"

// Mirrors the core `ObjectLineage` and `LinkLineage`: sources are described once, keyed, and the
// existence and each property point at one by its key.

const RequestedBySchema = z
  .object({ type: z.enum(["user", "serviceAccount"]), id: z.string() })
  .describe("Principal on whose behalf the commit ran; absent for automatic or anonymous work.")

const LineageSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("projection"),
    projectionId: z.string(),
    projectionRunId: z
      .string()
      .optional()
      .describe("Absent for a caller who cannot view the projection's runs."),
    datasetVersion: DatasetVersionRefSchema.optional().describe(
      "The dataset version applied. Absent for a caller who cannot view the dataset."
    ),
    rowOrigins: z
      .array(DatasetColumnRefSchema)
      .optional()
      .describe(
        "Upstream columns that decide which rows the version holds, which every value depends on. Absent when the version records no lineage or the caller cannot view it."
      ),
  }),
  z.object({
    kind: z.literal("edit"),
    commitId: z
      .string()
      .nullable()
      .describe("Null when the commits made at that instant cannot be told apart."),
    committedAt: z.string(),
    requestedBy: RequestedBySchema.optional(),
    executor: EventExecutorSchema.optional(),
    action: z
      .object({ actionId: z.string(), runId: z.string() })
      .optional()
      .describe("Absent for a direct write, and for an Action run the caller cannot view."),
  }),
  z.object({
    kind: z.literal("telemetry"),
    commitId: z.string(),
    committedAt: z.string(),
    projectionId: z.string().optional(),
    requestedBy: RequestedBySchema.optional(),
    executor: EventExecutorSchema.optional(),
  }),
  z.object({ kind: z.literal("identity") }),
])

const LineageSourcesSchema = z
  .record(LineageSourceSchema)
  .describe(
    "Keyed `projection:<id>`, `commit:<id>`, `commit@<instant>` when the commit is unknown, `telemetry:<commitId>` and `identity`."
  )

const RestrictedSchema = z
  .number()
  .int()
  .nonnegative()
  .describe("Steps left out because the caller cannot view them.")

const PropertyLineageSchema = z.object({
  source: z.string().describe("The source that decided the value: a key of `sources`."),
  column: z.string().optional(),
  origins: z.array(DatasetColumnRefSchema).optional(),
  removed: z.literal(true).optional(),
  at: z.string().optional(),
  replaced: z
    .object({
      source: z.string(),
      column: z.string().optional(),
      value: JsonValueSchema.optional(),
    })
    .optional(),
  resolution: z
    .discriminatedUnion("strategy", [
      z.object({ strategy: z.literal("editsWin") }),
      z.object({
        strategy: z.literal("mostRecent"),
        sourceUpdatedAt: z.string(),
        editedAt: z.string().optional(),
      }),
    ])
    .optional(),
})

export const ObjectLineageSchema = z.object({
  objectTypeId: z.string(),
  primaryId: z.string(),
  existence: z.object({ source: z.string() }),
  sources: LineageSourcesSchema,
  properties: z.record(PropertyLineageSchema),
  restricted: RestrictedSchema,
})

export const LinkLineageSchema = z.object({
  sourceTypeId: z.string(),
  sourceId: z.string(),
  linkId: z.string(),
  targetTypeId: z.string(),
  targetId: z.string(),
  existence: z.object({
    source: z.string(),
    columns: z.array(z.string()).optional(),
    origins: z.array(DatasetColumnRefSchema).optional(),
  }),
  sources: LineageSourcesSchema,
  restricted: RestrictedSchema,
})
