import {
  type SixbFailure,
  SYNC_RUN_FAILURE_CODES,
  type SyncRunFailureCode,
} from "@sixb/core/storage"
import { z } from "zod"
import { sixbFailureSchema } from "./common"
import { DatasetDefinitionSchema } from "./datasets"

const SyncRunFailureSchema: z.ZodType<SixbFailure<SyncRunFailureCode>> =
  sixbFailureSchema(SYNC_RUN_FAILURE_CODES)

export const SyncParamsSchema = z.object({
  syncId: z.string().min(1),
})

export const SyncRunStatusSchema = z.enum(["running", "succeeded", "failed", "cancelled"])

export const SyncRunsQuerySchema = z.object({
  syncId: z.string().optional(),
  datasetId: z.string().optional(),
  status: SyncRunStatusSchema.optional(),
  startedAfter: z.string().optional(),
  startedBefore: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
  order: z.enum(["asc", "desc"]).optional(),
})

export const RequestSyncRunBodySchema = z.object({
  expectedLatestVersionId: z.string().optional(),
  commitMessage: z.string().optional(),
})

const SyncTriggerSchema = z.object({
  type: z.literal("schedule"),
  scheduleId: z.string(),
})

export const SyncRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  syncId: z.string(),
  datasetId: z.string(),
  mode: z.enum(["snapshot", "append"]),
  status: SyncRunStatusSchema,
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  rowsRead: z.number().optional(),
  output: z
    .object({
      datasetId: z.string(),
      versionId: z.string(),
    })
    .optional(),
  expectedLatestVersionId: z.string().optional(),
  commitMessage: z.string().optional(),
  error: SyncRunFailureSchema.optional(),
})

export const SyncSchema = z.object({
  id: z.string(),
  mode: z.enum(["snapshot", "append"]),
  connector: z.object({
    id: z.string(),
    type: z.string(),
  }),
  target: z.object({
    kind: z.literal("dataset"),
    dataset: DatasetDefinitionSchema,
  }),
  triggers: z.array(SyncTriggerSchema),
  latestRun: SyncRunSchema.nullable(),
})

export const SyncRunListResponseSchema = z.object({
  runs: z.array(SyncRunSchema),
  hasMore: z.boolean(),
  total: z.number(),
})

export const RequestSyncRunResponseSchema = z.object({
  runId: z.string(),
  jobId: z.string(),
  syncId: z.string(),
  queuedAt: z.string(),
})
