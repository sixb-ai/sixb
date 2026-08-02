import { z } from "zod"
import { SixbFailureSchema } from "./common"
import { ActionParamSchema } from "./ontology"

export const ActionIdParamsSchema = z.object({
  actionId: z.string().min(1),
})

export const ActionRunIdParamsSchema = z.object({
  runId: z.string().min(1),
})

export const ActionSubjectSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("none"),
  }),
  z.object({
    kind: z.literal("object"),
    objectTypeId: z.string().min(1),
    primaryId: z.string().min(1),
  }),
])

export const RequestActionBodySchema = z.object({
  subject: ActionSubjectSchema.optional(),
  params: z.record(z.unknown()).optional(),
  runId: z.string().min(1).optional(),
})

export const RequestActionResponseSchema = z.object({
  runId: z.string(),
  queuedAt: z.string(),
  jobId: z.string().optional(),
  created: z.boolean(),
})

export const ActionCatalogItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  objectTypeId: z.string().optional(),
  params: z.array(ActionParamSchema),
  phases: z.object({
    validate: z.boolean(),
    writeback: z.boolean(),
    edits: z.boolean(),
    effects: z.boolean(),
  }),
})

export const ActionRunStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
])

export const ActionRunPhaseSchema = z.enum([
  "request",
  "enqueue",
  "validation",
  "writeback",
  "edits",
  "commit",
  "effects",
  "cancelled",
])

export const ActionRunsQuerySchema = z.object({
  actionId: z.string().optional(),
  status: ActionRunStatusSchema.optional(),
  objectTypeId: z.string().optional(),
  primaryId: z.string().optional(),
  startedAfter: z.string().optional(),
  startedBefore: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
  order: z.enum(["asc", "desc"]).optional(),
})

export const ActionRunFailureSchema = SixbFailureSchema.extend({
  phase: ActionRunPhaseSchema.optional(),
})

export const ActionRunSummarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  actionId: z.string(),
  subject: ActionSubjectSchema,
  status: ActionRunStatusSchema,
  phase: ActionRunPhaseSchema.optional(),
  queuedAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  error: ActionRunFailureSchema.optional(),
})

const ActionRunWritebackRecordSchema = z.object({
  status: z.enum(["succeeded", "failed"]),
  completedAt: z.string(),
  result: z.unknown().optional(),
  error: ActionRunFailureSchema.optional(),
})

const ActionRunEffectsRecordSchema = z.object({
  status: z.enum(["succeeded", "failed"]),
  completedAt: z.string(),
  error: ActionRunFailureSchema.optional(),
})

export const ActionRunDetailSchema = ActionRunSummarySchema.extend({
  params: z.record(z.unknown()),
  writeback: ActionRunWritebackRecordSchema.optional(),
  effects: ActionRunEffectsRecordSchema.optional(),
})

export const ActionRunListResponseSchema = z.object({
  runs: z.array(ActionRunSummarySchema),
  hasMore: z.boolean(),
  total: z.number(),
})
