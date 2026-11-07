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
})

export const LakeHealthResponseSchema = z.object({
  available: z.boolean().describe("Whether the lake storage provider supports maintenance"),
  cleanup: z.object({
    enabled: z.boolean().describe("Whether retention runs on its schedule"),
    keepVersionsFor: z.string(),
    deleteFilesAfter: z.string(),
    cleanupEvery: z.string(),
  }),
  datasets: z.array(DatasetStorageHealthSchema),
})
