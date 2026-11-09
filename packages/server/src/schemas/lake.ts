import { z } from "zod"

const DatasetStorageWarningSchema = z.object({
  code: z.enum(["partitioned-small-dataset"]),
  message: z.string(),
})

export const DatasetStorageHealthSchema = z.object({
  datasetId: z.string(),
  materialized: z.boolean().describe("Whether the dataset has a table in the lake"),
  rowCount: z.number().int(),
  dataFiles: z.number().int().describe("Data files its current rows are read from"),
  smallDataFiles: z.number().int().describe("Data files small enough that compaction merges them"),
  dataBytes: z.number().int(),
  deleteFiles: z.number().int().describe("Files listing deleted rows, until compaction"),
  inlinedRows: z.number().int().describe("Rows kept in the catalog rather than in files"),
  retainedSnapshots: z.number().int().describe("Commits still in the dataset's history"),
  partitionBy: z.array(z.string()),
  warnings: z.array(DatasetStorageWarningSchema),
  ingest: z
    .object({
      pendingDeliveries: z.number().int(),
      pendingChanges: z.number().int(),
      oldestReceivedAt: z
        .string()
        .datetime()
        .nullable()
        .describe("When the oldest waiting delivery arrived"),
      rejectedDeliveries: z
        .number()
        .int()
        .describe("Deliveries refused when written, kept for a week to read and send again"),
    })
    .nullable()
    .describe("Ingested changes waiting or refused; null when there are none"),
})

export const LakeHealthResponseSchema = z.object({
  available: z.boolean().describe("Whether the lake storage provider supports maintenance"),
  cleanup: z.object({
    state: z
      .enum(["off", "idle", "not-requested", "no-worker", "failing", "cleaning", "ok"])
      .describe(
        "What actually happens: `not-requested` when no orchestrator asks, `no-worker` when no lake worker runs what it asks"
      ),
    lastRequestedAt: z.string().nullable().describe("When the orchestrator last asked for cleanup"),
    lastRunAt: z.string().nullable().describe("When a lake worker last started a cleanup"),
    keepVersionsFor: z.string(),
    deleteFilesAfter: z.string(),
    cleanupEvery: z.string(),
  }),
  datasets: z.array(DatasetStorageHealthSchema),
})
