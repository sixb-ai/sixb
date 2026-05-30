import { z } from "zod"

export const WorkflowParamsSchema = z.object({
  workflowId: z.string().min(1),
})

export const WorkflowRunParamsSchema = z.object({
  runId: z.string().min(1),
})

export const WorkflowInterventionParamsSchema = z.object({
  interventionId: z.string().min(1),
})

export const WorkflowRunStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
])

export const WorkflowInterventionStatusSchema = z.enum([
  "pending",
  "submitted",
  "cancelled",
  "expired",
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

export const WorkflowInterventionsQuerySchema = z.object({
  workflowId: z.string().optional(),
  workflowRunId: z.string().optional(),
  nodeRunId: z.string().optional(),
  nodeId: z.string().optional(),
  nodeKey: z.string().optional(),
  interventionId: z.string().optional(),
  status: WorkflowInterventionStatusSchema.optional(),
  requestedAfter: z.string().optional(),
  requestedBefore: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
  order: z.enum(["asc", "desc"]).optional(),
})

export const RequestWorkflowRunBodySchema = z
  .object({
    input: z.record(z.unknown()).optional(),
  })
  .default({})

export const WorkflowInterventionActorSchema = z.object({
  principalType: z.enum(["user", "serviceAccount", "system"]),
  principalId: z.string().min(1),
})

export const SubmitWorkflowInterventionBodySchema = z.object({
  response: z.record(z.unknown()),
  submittedBy: WorkflowInterventionActorSchema.optional(),
})

export const CancelWorkflowInterventionBodySchema = z
  .object({
    cancelledBy: WorkflowInterventionActorSchema.optional(),
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
  z.object({
    type: z.literal("intervention"),
    id: z.string(),
    key: z.string(),
    input: z.record(z.unknown()),
    response: z.record(z.unknown()),
    description: z.string().optional(),
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
  nodeType: z.enum(["step", "action", "intervention"]),
  nodeId: z.string(),
  nodeKey: z.string(),
  status: z.enum(["running", "waiting", "succeeded", "failed", "cancelled"]),
  input: z.record(z.unknown()),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  output: z.record(z.unknown()).optional(),
  error: z.string().optional(),
})

export const WorkflowInterventionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  workflowId: z.string(),
  workflowRunId: z.string(),
  nodeRunId: z.string(),
  nodeIndex: z.number(),
  nodeId: z.string(),
  nodeKey: z.string(),
  interventionId: z.string(),
  input: z.record(z.unknown()),
  defaultResponse: z.record(z.unknown()),
  status: WorkflowInterventionStatusSchema,
  requestedAt: z.string(),
  expiresAt: z.string().optional(),
  submittedAt: z.string().optional(),
  submittedBy: WorkflowInterventionActorSchema.optional(),
  response: z.record(z.unknown()).optional(),
  cancelledAt: z.string().optional(),
  cancelledBy: WorkflowInterventionActorSchema.optional(),
  expiredAt: z.string().optional(),
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

export const WorkflowInterventionListResponseSchema = z.object({
  interventions: z.array(WorkflowInterventionSchema),
  hasMore: z.boolean(),
  total: z.number(),
})

export const SubmitWorkflowInterventionResponseSchema = z.object({
  intervention: WorkflowInterventionSchema,
  jobId: z.string(),
})

export const CancelWorkflowInterventionResponseSchema = z.object({
  intervention: WorkflowInterventionSchema,
})

export const RequestWorkflowRunResponseSchema = z.object({
  runId: z.string(),
  jobId: z.string(),
  workflowId: z.string(),
  queuedAt: z.string(),
})
