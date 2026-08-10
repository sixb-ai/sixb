import {
  type SixbFailure,
  WORKFLOW_RUN_FAILURE_CODES,
  type WorkflowRunFailureCode,
} from "@sixb/core/storage"
import { z } from "zod"
import { AiUsageSummarySchema } from "./ai-usage"
import { AgentRunFailureSchema } from "./agents"
import { JsonValueSchema, sixbFailureSchema } from "./common"

export const WorkflowIOSnapshotSchema = z.record(JsonValueSchema)

const WorkflowRunFailureSchema: z.ZodType<SixbFailure<WorkflowRunFailureCode>> = sixbFailureSchema(
  WORKFLOW_RUN_FAILURE_CODES
)

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
    input: WorkflowIOSnapshotSchema.optional(),
  })
  .default({})

export const WorkflowInterventionActorSchema = z.object({
  principalType: z.enum(["user", "serviceAccount", "system"]),
  principalId: z.string().min(1),
})

export const CancelWorkflowRunBodySchema = z.object({}).default({})

export const SubmitWorkflowInterventionBodySchema = z.object({
  response: WorkflowIOSnapshotSchema,
})

export const CancelWorkflowInterventionBodySchema = z.object({}).default({})

const WorkflowTriggerSchema = z.object({
  type: z.literal("schedule"),
  scheduleId: z.string(),
})

const WorkflowNodeSchema = z.union([
  z.object({
    type: z.literal("step"),
    id: z.string(),
    key: z.string(),
    input: WorkflowIOSnapshotSchema,
    output: WorkflowIOSnapshotSchema,
  }),
  z.object({
    type: z.literal("action"),
    id: z.string(),
    key: z.string(),
    objectTypeId: z.string().optional(),
    params: WorkflowIOSnapshotSchema,
  }),
  z.object({
    type: z.literal("intervention"),
    id: z.string(),
    key: z.string(),
    input: WorkflowIOSnapshotSchema,
    response: WorkflowIOSnapshotSchema,
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal("agent"),
    id: z.string(),
    key: z.string(),
    agentId: z.string(),
    input: WorkflowIOSnapshotSchema,
    output: WorkflowIOSnapshotSchema,
  }),
])

export const WorkflowRunSummarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  workflowId: z.string(),
  status: WorkflowRunStatusSchema,
  queuedAt: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  error: WorkflowRunFailureSchema.optional(),
  requestedBy: WorkflowInterventionActorSchema,
})

export const WorkflowRunDetailSchema = WorkflowRunSummarySchema.extend({
  input: WorkflowIOSnapshotSchema,
  output: WorkflowIOSnapshotSchema.optional(),
})

export const WorkflowAgentNodeExecutionSummarySchema = z.object({
  agentId: z.string(),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  attempt: z.number().int().nonnegative(),
  modelId: z.string().optional(),
  finishReason: z.string().optional(),
  usage: AiUsageSummarySchema.optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
})

export const WorkflowAgentNodeExecutionSchema = WorkflowAgentNodeExecutionSummarySchema.extend({
  nodeRunId: z.string(),
  prompt: z.string(),
  trace: z.array(z.unknown()).optional(),
  diagnostics: z.array(z.unknown()).optional(),
  error: AgentRunFailureSchema.optional(),
  createdAt: z.string(),
})

export const WorkflowNodeRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  workflowRunId: z.string(),
  workflowId: z.string(),
  nodeIndex: z.number(),
  nodeType: z.enum(["step", "action", "intervention", "agent"]),
  nodeId: z.string(),
  nodeKey: z.string(),
  status: z.enum(["running", "waiting", "succeeded", "failed", "cancelled"]),
  input: WorkflowIOSnapshotSchema,
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  output: WorkflowIOSnapshotSchema.optional(),
  error: WorkflowRunFailureSchema.optional(),
  agentExecution: WorkflowAgentNodeExecutionSummarySchema.optional(),
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
  input: WorkflowIOSnapshotSchema,
  defaultResponse: WorkflowIOSnapshotSchema,
  status: WorkflowInterventionStatusSchema,
  requestedAt: z.string(),
  expiresAt: z.string().optional(),
  submittedAt: z.string().optional(),
  submittedBy: WorkflowInterventionActorSchema.optional(),
  response: WorkflowIOSnapshotSchema.optional(),
  cancelledAt: z.string().optional(),
  cancelledBy: WorkflowInterventionActorSchema.optional(),
  expiredAt: z.string().optional(),
})

export const WorkflowSchema = z.object({
  id: z.string(),
  input: WorkflowIOSnapshotSchema,
  triggers: z.array(WorkflowTriggerSchema),
  nodes: z.array(WorkflowNodeSchema),
  latestRun: WorkflowRunSummarySchema.nullable(),
})

export const WorkflowRunListResponseSchema = z.object({
  runs: z.array(WorkflowRunSummarySchema),
  hasMore: z.boolean(),
  total: z.number(),
})

export const WorkflowRunDetailResponseSchema = z.object({
  run: WorkflowRunDetailSchema,
  nodes: z.array(WorkflowNodeRunSchema),
})

export const CancelWorkflowRunResponseSchema = WorkflowRunDetailResponseSchema

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
