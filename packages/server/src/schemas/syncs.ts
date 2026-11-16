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

export const SyncRunStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "cancelled"])
const SyncModeSchema = z.enum(["snapshot", "append", "merge"])

export const SyncRunsQuerySchema = z.object({
  syncId: z.string().optional(),
  connectionId: z.string().optional(),
  datasetId: z.string().optional(),
  status: SyncRunStatusSchema.optional(),
  startedAfter: z.string().optional(),
  startedBefore: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
  order: z.enum(["asc", "desc"]).optional(),
})

export const RequestSyncRunBodySchema = z.object({
  /** One connection to run, on a sync of an OAuth connector. Without it, every one you can run. */
  connectionId: z.string().optional(),
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
  /** The connection the run reads, on a sync of an OAuth connector. */
  connectionId: z.string().optional(),
  datasetId: z.string(),
  mode: SyncModeSchema,
  status: SyncRunStatusSchema,
  /** How many executions took the run: above one, it resumed after losing its worker. */
  attempt: z.number(),
  queuedAt: z.string(),
  startedAt: z.string().optional(),
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

const SyncAccountConnectionSchema = z.object({
  id: z.string(),
  owner: z.discriminatedUnion("type", [
    z.object({ type: z.literal("project") }),
    z.object({ type: z.literal("user"), id: z.string() }),
  ]),
  slot: z.string(),
  account: z.object({ id: z.string(), label: z.string() }),
})

/** One connected account of an OAuth connector, and the latest run of each of its syncs. */
export const ConnectorAccountSchema = z.object({
  connection: SyncAccountConnectionSchema,
  latestRuns: z.array(SyncRunSchema),
})

export const ConnectorAccountListResponseSchema = z.object({
  accounts: z.array(ConnectorAccountSchema),
})

export const ConnectorAccountsParamsSchema = z.object({
  connectorId: z.string().min(1),
})

/** How a sync of an OAuth connector's accounts stand, by their latest runs. */
const SyncAccountSummarySchema = z.object({
  total: z.number(),
  /** Their latest run failed because the account needs reconnecting. */
  needsReconnecting: z.number(),
  /** Their latest run failed for any other reason. */
  failing: z.number(),
})

export const SyncSchema = z.object({
  id: z.string(),
  mode: SyncModeSchema,
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
  /** On a sync of an OAuth connector: the accounts the caller may see. */
  accounts: SyncAccountSummarySchema.optional(),
})

export const ConnectionSyncRunsParamsSchema = z.object({
  connectorId: z.string().min(1),
  connectionId: z.string().min(1),
})

export const ConnectionSyncRunsResponseSchema = z.object({
  runs: z.array(SyncRunSchema),
})

export const SyncRunListResponseSchema = z.object({
  runs: z.array(SyncRunSchema),
  hasMore: z.boolean(),
  total: z.number(),
})

const RequestedSyncRunSchema = z.object({
  runId: z.string(),
  jobId: z.string(),
  syncId: z.string(),
  /** The connection the run reads, on a sync of an OAuth connector. */
  connectionId: z.string().optional(),
  queuedAt: z.string(),
})

/** One run for a static connector's sync; one per connection for an OAuth connector's sync. */
export const RequestSyncRunResponseSchema = z.object({
  runs: z.array(RequestedSyncRunSchema),
})
