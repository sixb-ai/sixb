import { AGENT_REASONING_LEVELS } from "@sixb/core"
import { z } from "zod"
import { JsonValueSchema } from "./common"

export const AgentIdParamsSchema = z.object({
  agentId: z.string().min(1),
})

export const AgentThreadParamsSchema = z.object({
  threadId: z.string().min(1),
})

export const AgentRunParamsSchema = z.object({
  runId: z.string().min(1),
})

export const AgentPrincipalSchema = z.object({
  type: z.enum(["user", "serviceAccount", "system"]),
  id: z.string().min(1),
})

export const AgentLoopConfigSchema = z.object({
  stopWhen: z
    .object({
      maxSteps: z.number().int().positive().optional(),
    })
    .optional(),
})

export const AgentReasoningLevelSchema = z.enum(AGENT_REASONING_LEVELS)

export const AgentCatalogItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  modelId: z.string().optional(),
  reasoning: AgentReasoningLevelSchema.optional(),
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
  AgentToolCallOutputSchema,
  AgentToolCallErrorSchema,
])

export const AgentMessageSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  threadId: z.string(),
  runId: z.string().nullable(),
  role: AgentMessageRoleSchema,
  authorPrincipal: AgentPrincipalSchema.optional(),
  seq: z.number(),
  parts: z.array(AgentMessagePartSchema),
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
  messageId: z.string().trim().min(1).optional(),
})

export const PostAgentMessageResponseSchema = z.object({
  threadId: z.string(),
  runId: z.string(),
  triggerMessageId: z.string(),
  jobId: z.string().optional(),
  createdThread: z.boolean(),
  streamId: z.string(),
})

export const AgentRunStatusSchema = z.enum(["running", "succeeded", "failed", "cancelled"])

export const AgentRunFinishReasonSchema = z.enum([
  "stop",
  "length",
  "content-filter",
  "tool-calls",
  "error",
  "other",
  "unknown",
])

export const AgentRunUsageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  totalTokens: z.number().optional(),
  reasoningTokens: z.number().optional(),
  cachedInputTokens: z.number().optional(),
})

export const AgentRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  threadId: z.string(),
  agentId: z.string(),
  triggerMessageId: z.string(),
  requestedByPrincipal: AgentPrincipalSchema,
  executionPrincipal: AgentPrincipalSchema.optional(),
  status: AgentRunStatusSchema,
  modelId: z.string().optional(),
  finishReason: AgentRunFinishReasonSchema.optional(),
  usage: AgentRunUsageSchema.optional(),
  error: z.string().optional(),
  attempt: z.number(),
  streamId: z.string(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
})
