import {
  PIPELINE_RUN_FAILURE_CODES,
  type PipelineRunFailureCode,
  type SixbFailure,
} from "@sixb/core/storage"
import { z } from "zod"
import { sixbFailureSchema } from "./common"
import { DatasetDefinitionSchema } from "./datasets"

const PipelineRunFailureSchema: z.ZodType<SixbFailure<PipelineRunFailureCode>> = sixbFailureSchema(
  PIPELINE_RUN_FAILURE_CODES
)

export const PipelineParamsSchema = z.object({
  pipelineId: z.string().min(1),
})

export const PipelineRunParamsSchema = z.object({
  runId: z.string().min(1),
})

export const PipelineRunStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
])
const PipelineStepRunStatusSchema = z.enum(["running", "succeeded", "failed", "cancelled"])

export const PipelineRunsQuerySchema = z.object({
  pipelineId: z.string().optional(),
  status: PipelineRunStatusSchema.optional(),
  startedAfter: z.string().optional(),
  startedBefore: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
  order: z.enum(["asc", "desc"]).optional(),
})

const DatasetVersionRefSchema = z.object({
  datasetId: z.string(),
  versionId: z.string(),
})

const PipelineTriggerSchema = z.object({
  type: z.literal("schedule"),
  scheduleId: z.string(),
})

const PipelineStepExecutorSchema = z.union([
  z.object({
    kind: z.literal("sql"),
    dialect: z.literal("duckdb"),
  }),
  z.object({
    kind: z.literal("run"),
  }),
])

export const PipelineRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  pipelineId: z.string(),
  status: PipelineRunStatusSchema,
  queuedAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  output: DatasetVersionRefSchema.optional(),
  error: PipelineRunFailureSchema.optional(),
})

export const PipelineStepRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  pipelineRunId: z.string(),
  pipelineId: z.string(),
  stepId: z.string(),
  datasetId: z.string(),
  mode: z.enum(["snapshot", "append"]),
  status: PipelineStepRunStatusSchema,
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  inputs: z.array(DatasetVersionRefSchema),
  output: DatasetVersionRefSchema.optional(),
  rowsWritten: z.number().optional(),
  error: PipelineRunFailureSchema.optional(),
})

export const PipelineStepSchema = z.object({
  id: z.string(),
  mode: z.enum(["snapshot", "append"]),
  executor: PipelineStepExecutorSchema,
  inputs: z.array(
    z.object({
      name: z.string(),
      dataset: DatasetDefinitionSchema,
    })
  ),
  output: DatasetDefinitionSchema,
})

export const PipelineSchema = z.object({
  id: z.string(),
  triggers: z.array(PipelineTriggerSchema),
  graph: z.object({
    kind: z.literal("sequence"),
    nodes: z.array(
      z.object({
        kind: z.literal("step"),
        step: PipelineStepSchema,
      })
    ),
  }),
  latestRun: PipelineRunSchema.nullable(),
})

export const PipelineRunListResponseSchema = z.object({
  runs: z.array(PipelineRunSchema),
  hasMore: z.boolean(),
  total: z.number(),
})

export const PipelineRunDetailResponseSchema = z.object({
  run: PipelineRunSchema,
  steps: z.array(PipelineStepRunSchema),
})

export const RequestPipelineRunResponseSchema = z.object({
  runId: z.string(),
  jobId: z.string(),
  pipelineId: z.string(),
  queuedAt: z.string(),
})
