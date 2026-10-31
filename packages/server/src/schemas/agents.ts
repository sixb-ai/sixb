import { MAX_AGENT_CONTEXT_ENTRIES } from "@sixb/core"
import { MAX_AGENT_CONTEXT_LABEL_LENGTH } from "@sixb/core/agents/context"
import { LANGUAGE_MODEL_TIERS } from "@sixb/core/models"
import {
  AGENT_RUN_DIAGNOSTIC_CODES,
  AGENT_RUN_FAILURE_CODES,
  AGENT_RUN_FINISH_REASONS,
  type AgentRunFailureCode,
  type SixbFailure,
} from "@sixb/core/storage"
import { z } from "zod"
import {
  AgentApprovalCallSummarySchema,
  AgentApprovalModeSchema,
  AgentApprovalModeSourceSchema,
  AgentApprovalOutcomeSchema,
  AgentApprovalSchema,
  AgentApprovalStatusSchema,
} from "./agent-approvals"
import { AiCostSummarySchema } from "./ai-accounting"
import { AiUsageSummarySchema } from "./ai-usage"
import { ErrorResponseSchema, JsonValueSchema, sixbFailureSchema } from "./common"
import { FileRefSchema } from "./files"
import { LanguageModelRefSchema, ModelReasoningSchema } from "./models"

export const AgentRunFailureSchema: z.ZodType<SixbFailure<AgentRunFailureCode>> =
  sixbFailureSchema(AGENT_RUN_FAILURE_CODES)

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
  label: z
    .string()
    .min(1)
    .max(MAX_AGENT_CONTEXT_LABEL_LENGTH)
    .optional()
    .describe("Shown in the chat instead of the object's title. Never sent to the model."),
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

export const AgentDescriptorSchema = z.object({
  name: z.string(),
  model: LanguageModelRefSchema,
})

export const AgentThreadStatusSchema = z.enum(["active", "archived"])

export const AgentThreadListQuerySchema = z
  .object({
    status: AgentThreadStatusSchema.optional(),
    /** `true` lists the threads other users added the caller to, instead of the caller's own. */
    sharedWithMe: z.enum(["true", "false"]).optional(),
    limit: z.string().optional(),
    offset: z.string().optional(),
    order: z.enum(["asc", "desc"]).optional(),
  })
  .strict()

export const CreateAgentThreadBodySchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    threadId: z.string().trim().min(1).optional(),
    sandbox: z.record(z.string(), JsonValueSchema).optional(),
    /** Run its turns on your computer, which claims them, instead of in the cloud. */
    runsOn: z.literal("computer").optional(),
  })
  .strict()

/** A user the thread's owner added: they read the whole conversation and talk in it. */
/** A principal with its account's display name, as message authors and thread people are named. */
export const AgentMessageAuthorSchema = AgentPrincipalSchema.extend({
  displayName: z.string().optional(),
})

export const AgentThreadParticipantSchema = z.object({
  principal: AgentMessageAuthorSchema.extend({ type: z.literal("user") }),
  addedAt: z.string(),
  addedBy: AgentPrincipalSchema,
})

export const AgentThreadSchema = z.object({
  sandboxState: z
    .object({
      name: z.string(),
      status: z.enum(["new", "busy", "ready", "blocked", "unavailable"]),
      initialized: z.boolean(),
    })
    .optional(),
  id: z.string(),
  projectId: z.string(),
  /** A conversation, or the thread a sub-agent works in: read through its conversation. */
  kind: z.enum(["conversation", "subagent"]),
  /** A sub-agent's thread: its conversation, the turn that spawned it, and its key there. */
  parent: z
    .object({
      threadId: z.string(),
      /** The turn that spawned it; its later runs work under the turns that go on with it. */
      spawnedBy: z.string(),
      key: z.string(),
    })
    .optional(),
  ownerPrincipal: AgentPrincipalSchema,
  /** The owner, named by their account. */
  owner: AgentMessageAuthorSchema,
  participants: z.array(AgentThreadParticipantSchema),
  title: z.string().optional(),
  sandboxParams: z.record(z.string(), JsonValueSchema).optional(),
  /** Its turns run on its owner's computer; absent, in the cloud. */
  runsOn: z.literal("computer").optional(),
  status: AgentThreadStatusSchema,
  activeRunId: z.string().nullable(),
  lastMessageAt: z.string().optional(),
  messageCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Your mode in this thread, when the thread is read alone. */
  approvalMode: AgentApprovalModeSchema.optional(),
  /**
   * Where your mode in this thread comes from, with `approvalMode`. `run`: a sub-agent's thread,
   * whose mode is its latest run's, copied from the turn it works under, for every reader.
   */
  approvalModeSource: AgentApprovalModeSourceSchema.optional(),
})

export const AgentThreadListResponseSchema = z.object({
  threads: z.array(AgentThreadSchema),
  hasMore: z.boolean(),
  total: z.number(),
})

export const CreateAgentThreadResponseSchema = z.object({
  thread: AgentThreadSchema,
})

export const AddAgentThreadParticipantsBodySchema = z
  .object({
    /**
     * Active users of the project, by id or by their account's email; someone already taking part
     * is left as they are.
     */
    users: z
      .array(
        z.union([
          z.object({ type: z.literal("user"), id: z.string().trim().min(1) }).strict(),
          z.object({ email: z.string().trim().min(1) }).strict(),
        ])
      )
      .min(1)
      .max(50),
  })
  .strict()

export const AgentThreadParticipantParamsSchema = AgentThreadParamsSchema.extend({
  userId: z.string().min(1),
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

/** The user asked to continue an answer cut short; Sixb writes what the model reads. */
const AgentContinuationPartSchema = z.object({
  type: z.literal("continuation"),
})

/** How a call the Agent held ended; Sixb writes it at the start of the next message. */
const AgentApprovalOutcomePartSchema = z.object({
  type: z.literal("approval-outcome"),
  approvalId: z.string(),
  status: AgentApprovalStatusSchema.exclude(["pending"]),
  call: AgentApprovalCallSummarySchema,
  outcome: AgentApprovalOutcomeSchema.optional(),
  /** The turn's sub-agent that made the call, when the turn did not make it itself. */
  caller: z
    .object({
      runId: z.string(),
      key: z.string(),
      /** The message resumed the turn and the sub-agent, paused on its calls, went on. */
      continues: z.literal(true).optional(),
    })
    .optional(),
})

/**
 * A message a sub-agent's parent sent it, as it read it before a step: a steer, or the answer to
 * the question it asked (`inReplyTo`). Only a sub-agent's thread holds one.
 */
export const AgentMailPartSchema = z.object({
  type: z.literal("mail"),
  id: z.string(),
  from: z.literal("parent"),
  kind: z.enum(["message", "answer"]),
  inReplyTo: z.string().optional(),
  text: z.string(),
  /** It came as the sub-agent answered, so it wrote its result again. */
  afterAnswer: z.literal(true).optional(),
})

export const AgentMessagePartSchema = z.union([
  AgentTextPartSchema,
  AgentContinuationPartSchema,
  AgentApprovalOutcomePartSchema,
  AgentReasoningPartSchema,
  AgentStepStartPartSchema,
  AgentFilePartSchema,
  AgentProviderStatePartSchema,
  AgentContextPartSchema,
  AgentToolCallOutputSchema,
  AgentToolCallErrorSchema,
  AgentMailPartSchema,
])

export const AgentRunDiagnosticSchema = z.object({
  code: z.enum(AGENT_RUN_DIAGNOSTIC_CODES),
  severity: z.enum(["warning", "error"]),
  scope: z.enum(["run"]),
  message: z.string(),
})

export const AgentMessageCompactionSchema = z.object({
  checkpointId: z.string(),
  summary: z.string(),
  createdAt: z.string(),
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
  /** A durable context summary created before this response's model call. */
  compaction: AgentMessageCompactionSchema.optional(),
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
  /** The page's distinct authors, to name each message's `authorPrincipal`. */
  authors: z.array(AgentMessageAuthorSchema),
  hasMore: z.boolean(),
  total: z.number(),
})

export const PostAgentMessageBodySchema = z
  .object({
    /** Required unless `continue` is set or `attachments` are the whole message. */
    text: z.string().trim().min(1).optional(),
    /** Continue the previous answer after it reached the turn limit, without text of its own. */
    continue: z.literal(true).optional(),
    model: LanguageModelRefSchema.optional(),
    reasoning: ModelReasoningSchema.optional(),
    /** IANA time zone of the person asking. The Agent presents dates and times in it. */
    timeZone: z.string().trim().min(1).max(100).optional(),
    /** BCP 47 language of the person asking. */
    locale: z.string().trim().min(1).max(100).optional(),
    /** What this turn may change without asking you. Omitted: your choice in the thread. */
    approvalMode: AgentApprovalModeSchema.optional(),
    attachments: z.array(FileRefSchema).optional(),
    context: z.array(AgentContextEntryInputSchema).max(MAX_AGENT_CONTEXT_ENTRIES).optional(),
    messageId: z.string().trim().min(1).optional(),
  })
  .strict()

/** A refused message request, with the stable code of the reason, such as `invalid_locale`. */
export const AgentRequestErrorResponseSchema = ErrorResponseSchema.extend({
  code: z.string().optional(),
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
  /** A conversation's turn, or a sub-agent's run in its own thread. */
  kind: z.enum(["conversation", "subagent"]),
  threadId: z.string(),
  triggerMessageId: z.string(),
  /** A sub-agent's: the turn it works under, whose deadline, mode and stop it shares. */
  parentRunId: z.string().optional(),
  requestedBy: AgentAuthorizablePrincipalSchema.optional(),
  status: AgentRunStatusSchema,
  model: LanguageModelRefSchema.optional(),
  /** With tiers, the tier of the model the turn runs on. */
  tier: z.enum(LANGUAGE_MODEL_TIERS).optional(),
  reasoning: ModelReasoningSchema.optional(),
  /** What the turn could change without asking. Absent on turns from before approval modes. */
  approvalMode: AgentApprovalModeSchema.optional(),
  /** Its owner's computer claims it; absent, the cloud runs it. */
  runsOn: z.literal("computer").optional(),
  modelId: z.string().optional(),
  /**
   * `awaiting_approval`: the turn succeeded and paused on calls waiting for its requester. It stays
   * so: a later turn continues it once they decided on every call, unless a call was set aside or
   * the turn stopped. The thread's approvals say where they stand.
   */
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

export const DecideAgentApprovalResponseSchema = z.object({
  approval: AgentApprovalSchema,
  /** The turn that resumed the paused one, when this decision was its last. */
  run: AgentRunSchema.optional(),
  /**
   * The paused turn could not resume; the decision and the call's outcome stand. `retrying`: Sixb
   * resumes it once it can. Otherwise the thread's next message tells the Agent how its calls ended.
   */
  resume: z
    .object({
      status: z.literal("refused"),
      code: z.string(),
      message: z.string(),
      retrying: z.boolean(),
    })
    .optional(),
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

/** A file a turn and its sub-agent hand each other, by its path in the sub-agent's sandbox. */
export const AgentChildFileSchema = z.object({
  path: z.string(),
  fileRef: FileRefSchema,
})

export const AgentChildRunSchema = z.object({
  id: z.string(),
  /** The turn the run worked under: the one that spawned the sub-agent, or one that went on. */
  parentRunId: z.string(),
  status: AgentRunStatusSchema,
  finishReason: AgentRunFinishReasonSchema.optional(),
  error: AgentRunFailureSchema.optional(),
  modelId: z.string().optional(),
  attempt: z.number(),
  /** Subscribe to it on `/ws/agents` with the run's id while it is at work. */
  streamId: z.string(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  /** What it answered, and the files it wrote under `out/`, by path relative to it. */
  result: z
    .object({
      text: z.string(),
      files: z.array(AgentChildFileSchema).optional(),
      /** Why none of what it wrote under `out/` came back. */
      filesError: z.string().optional(),
    })
    .optional(),
  usage: AiUsageSummarySchema.optional(),
  cost: AiCostSummarySchema.optional(),
})

/** What a paused sub-agent waits for before it goes on. */
export const AgentChildAwaitingSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("approval"),
    /** Its calls still waiting for the turn's requester. */
    approvalIds: z.array(z.string()),
  }),
  /** Its calls were decided: it continues once its turn resumes. */
  z.object({ type: z.literal("resume") }),
  /** It paused on the question it asked: a later turn of the conversation answers it. */
  z.object({
    type: z.literal("answer"),
    question: z.object({ id: z.string(), text: z.string() }),
  }),
])

/**
 * Why a paused sub-agent never continues. On its calls: a new message set them aside, one expired,
 * or its turn was stopped, its requester leaving the conversation among the reasons. On its
 * question: `replaced`, the Agent spawned another sub-agent under its key.
 */
export const AgentChildEndedSchema = z.object({
  reason: z.enum(["superseded", "expired", "stopped", "replaced"]),
})

export const AgentChildSchema = z.object({
  /** Its first run's id: the one `spawn_agent` answered with. */
  id: z.string(),
  /** Its own thread: `GET /api/agent-threads/:threadId/messages` reads what it did. */
  threadId: z.string(),
  projectId: z.string(),
  /** The turn that spawned it. */
  spawnedBy: z.string(),
  key: z.string(),
  task: z.string(),
  model: LanguageModelRefSchema,
  tier: z.enum(LANGUAGE_MODEL_TIERS).optional(),
  reasoning: ModelReasoningSchema.optional(),
  /** What its parent handed it, by path in its sandbox. */
  handedFiles: z.array(AgentChildFileSchema),
  /** Its latest run's. */
  status: AgentRunStatusSchema,
  /**
   * `awaiting_approval` or `awaiting_answer`: it paused on held calls or on its question.
   * `awaiting` says what it waits for, or `ended` why it will not continue.
   */
  finishReason: AgentRunFinishReasonSchema.optional(),
  error: AgentRunFailureSchema.optional(),
  awaiting: AgentChildAwaitingSchema.optional(),
  ended: AgentChildEndedSchema.optional(),
  /** Its run at work, which streams on `/ws/agents`; `null` when none is. */
  activeRunId: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().optional(),
  /** Every run of it, and what those ran. */
  usage: AiUsageSummarySchema.optional(),
  cost: AiCostSummarySchema.optional(),
  /** Oldest first: the run spawned, then each that continued it. */
  runs: z.array(AgentChildRunSchema),
})

export const AgentChildListQuerySchema = z.object({
  /** Only those this turn of the conversation spawned. */
  runId: z.string().min(1).optional(),
})

export const AgentChildListResponseSchema = z.object({
  children: z.array(AgentChildSchema),
})
