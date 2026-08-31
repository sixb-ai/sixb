import { MAX_AGENT_CONTEXT_ENTRIES } from "@sixb/core"
import {
  AGENT_RUN_DIAGNOSTIC_CODES,
  AGENT_RUN_FAILURE_CODES,
  AGENT_RUN_FINISH_REASONS,
  type AgentRunFailureCode,
  type SixbFailure,
} from "@sixb/core/storage"
import { z } from "zod"
import { AiCostSummarySchema } from "./ai-accounting"
import { AiUsageSummarySchema } from "./ai-usage"
import { JsonValueSchema, sixbFailureSchema } from "./common"
import { FileRefSchema } from "./files"
import { ModelReasoningLevelSchema, ModelReasoningSchema } from "./models"

export const AgentRunFailureSchema: z.ZodType<SixbFailure<AgentRunFailureCode>> =
  sixbFailureSchema(AGENT_RUN_FAILURE_CODES)

export const AgentIdParamsSchema = z.object({
  agentId: z.string().min(1),
})

export const AgentThreadParamsSchema = z.object({
  threadId: z.string().min(1),
})

export const AgentRunParamsSchema = z.object({
  runId: z.string().min(1),
})

export const AgentMessageFileContentParamsSchema = AgentThreadParamsSchema.extend({
  messageId: z.string().min(1),
})

export const AgentPrincipalSchema = z.object({
  type: z.enum(["user", "serviceAccount", "system"]),
  id: z.string().min(1),
})

export const AgentAuthorizablePrincipalSchema = z.object({
  type: z.enum(["user", "serviceAccount"]),
  id: z.string().min(1),
})

export const AgentObjectContextSchema = z.object({
  kind: z.literal("object"),
  ref: z.object({
    objectTypeId: z.string().min(1),
    primaryId: z.string().min(1),
  }),
})

export const AgentAppStateContextSchema = z.object({
  kind: z.literal("app-state"),
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  value: JsonValueSchema,
})

export const AgentContextInputSchema = z.discriminatedUnion("kind", [
  AgentObjectContextSchema,
  AgentAppStateContextSchema,
])

export const AgentContextOriginSchema = z.enum(["ambient", "explicit"])

export const AgentContextEntryInputSchema = z.object({
  context: AgentContextInputSchema,
  origin: AgentContextOriginSchema,
})

export const AgentContextPartSchema = AgentContextEntryInputSchema.extend({
  type: z.literal("context"),
})

export const AgentLoopConfigSchema = z.object({
  stopWhen: z
    .object({
      maxSteps: z.number().int().positive().optional(),
    })
    .optional(),
})

export const AgentReasoningLevelSchema = ModelReasoningLevelSchema
export const AgentReasoningSchema = ModelReasoningSchema

export const AgentCatalogItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  modelId: z.string().optional(),
  reasoning: AgentReasoningSchema.optional(),
  groupIds: z.array(z.string()),
  loop: AgentLoopConfigSchema.optional(),
})

export const AgentThreadStatusSchema = z.enum(["active", "archived"])

export const AgentThreadListQuerySchema = z.object({
  agentId: z.string().optional(),
  status: AgentThreadStatusSchema.optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
  order: z.enum(["asc", "desc"]).optional(),
})

export const CreateAgentThreadBodySchema = z.object({
  agentId: z.string().min(1),
  title: z.string().trim().min(1).optional(),
  threadId: z.string().trim().min(1).optional(),
})

export const AgentThreadSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  agentId: z.string(),
  ownerPrincipal: AgentPrincipalSchema,
  title: z.string().optional(),
  status: AgentThreadStatusSchema,
  activeRunId: z.string().nullable(),
  lastMessageAt: z.string().optional(),
  messageCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const AgentThreadListResponseSchema = z.object({
  threads: z.array(AgentThreadSchema),
  hasMore: z.boolean(),
  total: z.number(),
})

export const CreateAgentThreadResponseSchema = z.object({
  thread: AgentThreadSchema,
})

export const AgentMessageRoleSchema = z.enum(["system", "user", "assistant"])

const AgentTextPartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  providerMetadata: JsonValueSchema.optional(),
})

const AgentReasoningPartSchema = z.object({
  type: z.literal("reasoning"),
  text: z.string(),
  providerMetadata: JsonValueSchema.optional(),
})

const AgentStepStartPartSchema = z.object({
  type: z.literal("step-start"),
})

const AgentFilePartSchema = z.object({
  type: z.literal("file"),
  fileRef: FileRefSchema,
  providerMetadata: JsonValueSchema.optional(),
})

const AgentProviderStatePartSchema = z.object({
  type: z.literal("provider-state"),
  providerId: z.string(),
  data: JsonValueSchema,
})

const AgentToolCallBaseSchema = z.object({
  type: z.literal("tool-call"),
  toolCallId: z.string(),
  toolName: z.string(),
  dynamic: z.boolean().optional(),
  providerExecuted: z.boolean().optional(),
  input: JsonValueSchema,
  providerMetadata: JsonValueSchema.optional(),
})

const AgentToolCallOutputSchema = AgentToolCallBaseSchema.extend({
  state: z.literal("output-available"),
  output: JsonValueSchema,
})

const AgentToolCallErrorSchema = AgentToolCallBaseSchema.extend({
  state: z.literal("output-error"),
  errorText: z.string(),
})

export const AgentMessagePartSchema = z.union([
  AgentTextPartSchema,
  AgentReasoningPartSchema,
  AgentStepStartPartSchema,
  AgentFilePartSchema,
  AgentProviderStatePartSchema,
  AgentContextPartSchema,
  AgentToolCallOutputSchema,
  AgentToolCallErrorSchema,
])

export const AgentRunDiagnosticSchema = z.object({
  code: z.enum(AGENT_RUN_DIAGNOSTIC_CODES),
  severity: z.enum(["warning", "error"]),
  scope: z.literal("output"),
  path: z.string().optional(),
  message: z.string(),
})

export const AgentMessageSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  threadId: z.string(),
  runId: z.string().nullable(),
  role: AgentMessageRoleSchema,
  authorPrincipal: AgentPrincipalSchema.optional(),
  seq: z.number(),
  parts: z.array(AgentMessagePartSchema),
  /** Platform-authored annotations associated with this message's run. */
  annotations: z.array(AgentRunDiagnosticSchema),
  metadata: JsonValueSchema.optional(),
  contentVersion: z.number(),
  createdAt: z.string(),
  completedAt: z.string().optional(),
})

export const AgentMessagesQuerySchema = z.object({
  role: AgentMessageRoleSchema.optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
  order: z.enum(["asc", "desc"]).optional(),
})

export const AgentMessageListResponseSchema = z.object({
  messages: z.array(AgentMessageSchema),
  hasMore: z.boolean(),
  total: z.number(),
})

export const PostAgentMessageBodySchema = z.object({
  text: z.string().trim().min(1),
  attachments: z.array(FileRefSchema).optional(),
  context: z.array(AgentContextEntryInputSchema).max(MAX_AGENT_CONTEXT_ENTRIES).optional(),
  messageId: z.string().trim().min(1).optional(),
})

export const CancelAgentRunBodySchema = z.object({
  runId: z.string().trim().min(1),
})

export const AgentRunStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
])

export const AgentRunFinishReasonSchema = z.enum(AGENT_RUN_FINISH_REASONS)

export const AgentRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  threadId: z.string(),
  agentId: z.string(),
  triggerMessageId: z.string(),
  requestedBy: AgentAuthorizablePrincipalSchema.optional(),
  status: AgentRunStatusSchema,
  modelId: z.string().optional(),
  finishReason: AgentRunFinishReasonSchema.optional(),
  usage: AiUsageSummarySchema.optional(),
  cost: AiCostSummarySchema.optional(),
  diagnostics: z.array(AgentRunDiagnosticSchema).optional(),
  error: AgentRunFailureSchema.optional(),
  attempt: z.number(),
  streamId: z.string(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
})

export const PostAgentMessageResponseSchema = z.object({
  run: AgentRunSchema,
})

export const CancelAgentRunResponseSchema = z.object({
  run: AgentRunSchema,
})

export const RetryAgentRunResponseSchema = z.object({
  run: AgentRunSchema,
})

export const AgentRunListQuerySchema = z.object({
  status: AgentRunStatusSchema.optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
  order: z.enum(["asc", "desc"]).optional(),
})

export const AgentRunListResponseSchema = z.object({
  runs: z.array(AgentRunSchema),
  hasMore: z.boolean(),
  total: z.number(),
})
