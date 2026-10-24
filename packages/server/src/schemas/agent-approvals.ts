import { SIXB_ERROR_CODES } from "@sixb/core/internal/errors"
import {
  AGENT_APPROVAL_MODES,
  AGENT_APPROVAL_STATUSES,
  AGENT_HOLDING_APPROVAL_MODES,
} from "@sixb/core/storage"
import { z } from "zod"
import { ActionRunFailureSchema, ActionSubjectSchema } from "./actions"
import { JsonValueSchema, PrincipalSchema, sixbFailureSchema } from "./common"

/**
 * What the Agent may change without asking: `manual` asks for every action and workflow,
 * `accept-edits` runs the actions that only change Sixb, `auto` runs everything.
 */
export const AgentApprovalModeSchema = z.enum(AGENT_APPROVAL_MODES)

export const AgentApprovalStatusSchema = z.enum(AGENT_APPROVAL_STATUSES)

/** Where your mode comes from: your choice in the thread, your default, or none yet. */
export const AgentApprovalModeSourceSchema = z.enum(["thread", "default", "fallback", "run"])

/** The held call as the Agent asked for it, without its params. */
export const AgentApprovalCallSummarySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("action"), actionId: z.string(), subject: ActionSubjectSchema }),
  z.object({ kind: z.literal("workflow"), workflowId: z.string() }),
])

/** The held call, as it runs once approved. */
export const AgentApprovalCallSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("action"),
    actionId: z.string(),
    subject: ActionSubjectSchema,
    /** Normalized: what runs once approved. */
    params: z.record(JsonValueSchema),
    actionRunId: z.string(),
    /** `external` when the action has a writeback or effects. */
    effect: z.enum(["ontology", "external"]),
  }),
  z.object({
    kind: z.literal("workflow"),
    workflowId: z.string(),
    /** As the run stores it. */
    input: z.record(JsonValueSchema),
    workflowRunId: z.string(),
  }),
])

/** What the approved call gave when it ran. */
export const AgentApprovalOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("action-run"),
    runId: z.string(),
    status: z.enum(["succeeded", "failed"]),
    error: ActionRunFailureSchema.optional(),
  }),
  z.object({ kind: z.literal("workflow-run"), runId: z.string(), queuedAt: z.string() }),
  z.object({ kind: z.literal("error"), error: sixbFailureSchema(SIXB_ERROR_CODES) }),
])

export const AgentApprovalSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  /** The turn that made the call. */
  runId: z.string(),
  /** The turn itself, or the child of it that made the call. */
  callerRunId: z.string(),
  /** The child that made the call, by the key the turn spawned it with; absent for the turn's own. */
  caller: z.object({ runId: z.string(), key: z.string() }).optional(),
  /** Who asked for the turn: the only one who decides. */
  requestedBy: PrincipalSchema,
  /** The mode that held the call. */
  mode: z.enum(AGENT_HOLDING_APPROVAL_MODES),
  status: AgentApprovalStatusSchema,
  call: AgentApprovalCallSchema,
  createdAt: z.string(),
  expiresAt: z.string(),
  decidedAt: z.string().optional(),
  decidedBy: PrincipalSchema.optional(),
  outcome: AgentApprovalOutcomeSchema.optional(),
  /** Whether a later message told the Agent how it ended. */
  reported: z.boolean(),
})

export const AgentApprovalListQuerySchema = z.object({
  status: AgentApprovalStatusSchema.optional(),
  runId: z.string().min(1).optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
})

export const MyAgentApprovalListQuerySchema = AgentApprovalListQuerySchema.omit({ runId: true })

export const AgentApprovalListResponseSchema = z.object({
  approvals: z.array(AgentApprovalSchema),
  hasMore: z.boolean(),
  total: z.number(),
})

export const AgentApprovalParamsSchema = z.object({
  threadId: z.string().min(1),
  approvalId: z.string().min(1),
})

export const DecideAgentApprovalBodySchema = z
  .object({
    decision: z.enum(["approve", "deny"]),
    /** With `approve`: also let your turns in this thread run such calls without asking. */
    always: z.literal(true).optional(),
  })
  .strict()

export const AgentPreferencesBodySchema = z
  .object({ approvalMode: AgentApprovalModeSchema })
  .strict()

export const AgentThreadApprovalModeBodySchema = z
  .object({
    /** `null` clears your choice: your turns in the thread follow your default again. */
    approvalMode: AgentApprovalModeSchema.nullable(),
  })
  .strict()

export const AgentPreferencesSchema = z.object({
  /** The mode of your turns in threads where you chose none. */
  approvalMode: AgentApprovalModeSchema,
  /** `fallback` until you choose a default. */
  approvalModeSource: AgentApprovalModeSourceSchema.exclude(["thread", "run"]),
})
