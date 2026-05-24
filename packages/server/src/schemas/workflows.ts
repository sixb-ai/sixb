import { z } from "zod"

export const WorkflowParamsSchema = z.object({
  workflowId: z.string().min(1),
})

export const WorkflowRunParamsSchema = z.object({
  runId: z.string().min(1),
})

export const WorkflowRunStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
])

export const WorkflowRunsQuerySchema = z.object({
  workflowId: z.string().optional(),
  status: WorkflowRunStatusSchema.optional(),
  startedAfter: z.string().optional(),
  startedBefore: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
  order: z.enum(["asc", "desc"]).optional(),
})

export const RequestWorkflowRunBodySchema = z
  .object({
    input: z.record(z.unknown()).optional(),
  })
  .default({})

const WorkflowTriggerSchema = z.object({
  type: z.literal("schedule"),
  scheduleId: z.string(),
})

const WorkflowNodeSchema = z.union([
  z.object({
    type: z.literal("step"),
    id: z.string(),
    key: z.string(),
    input: z.record(z.unknown()),
    output: z.record(z.unknown()),
  }),
  z.object({
    type: z.literal("action"),
    id: z.string(),
    key: z.string(),
    targetObjectTypeId: z.string(),
    params: z.record(z.unknown()),
  }),
])

export const WorkflowRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  workflowId: z.string(),
  status: WorkflowRunStatusSchema,
  input: z.record(z.unknown()),
  queuedAt: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  error: z.string().optional(),
})

export const WorkflowNodeRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  workflowRunId: z.string(),
  workflowId: z.string(),
  nodeIndex: z.number(),
  nodeType: z.enum(["step", "action"]),
  nodeId: z.string(),
  nodeKey: z.string(),
  status: z.enum(["running", "succeeded", "failed", "cancelled"]),
  input: z.record(z.unknown()),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  output: z.record(z.unknown()).optional(),
  error: z.string().optional(),
})

export const WorkflowSchema = z.object({
  id: z.string(),
  input: z.record(z.unknown()),
  triggers: z.array(WorkflowTriggerSchema),
  nodes: z.array(WorkflowNodeSchema),
  latestRun: WorkflowRunSchema.nullable(),
})

export const WorkflowRunListResponseSchema = z.object({
  runs: z.array(WorkflowRunSchema),
  hasMore: z.boolean(),
  total: z.number(),
})

export const WorkflowRunDetailResponseSchema = z.object({
  run: WorkflowRunSchema,
  nodes: z.array(WorkflowNodeRunSchema),
})

export const RequestWorkflowRunResponseSchema = z.object({
  runId: z.string(),
  jobId: z.string(),
  workflowId: z.string(),
  queuedAt: z.string(),
})
