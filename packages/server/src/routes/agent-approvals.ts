import type { AgentApprovalRecord, SixbHostView } from "@sixb/core"
import type { Elysia } from "elysia"
import { requireRequestSixb } from "../auth/scope"
import { SIXB_SESSION_MUTATION_SECURITY_REQUIREMENT } from "../openapi/security"
import { OPENAPI_TAGS } from "../openapi/tags"
import {
  AgentApprovalListQuerySchema,
  AgentApprovalListResponseSchema,
  AgentApprovalParamsSchema,
  AgentApprovalSchema,
  AgentPreferencesBodySchema,
  AgentPreferencesSchema,
  AgentThreadApprovalModeBodySchema,
  DecideAgentApprovalBodySchema,
  DecideAgentApprovalResponseSchema,
  MyAgentApprovalListQuerySchema,
} from "../schemas/agent-approvals"
import {
  AgentRequestErrorResponseSchema,
  AgentThreadParamsSchema,
  AgentThreadSchema,
} from "../schemas/agents"
import { ErrorResponseSchema } from "../schemas/common"
import { parseOptionalInt, toIsoString, unconfiguredStorageResponse } from "../utils/http"
import { handleAgentRouteError, serializeThread } from "./agents"

const DECIDING =
  "Only whoever asked for the turn decides: an approved call runs now, as the turn, with the rights their request carries, and the approval comes back with its outcome. The Agent reads how it ended at the start of the thread's next message. A new message sets the calls still waiting aside. None of these routes is reachable from the Agent's sandbox."

function serializeApproval(
  approval: AgentApprovalRecord
): ReturnType<typeof AgentApprovalSchema.parse> {
  return AgentApprovalSchema.parse({
    id: approval.id,
    threadId: approval.threadId,
    runId: approval.runId,
    callerRunId: approval.callerRunId,
    requestedBy: approval.requestedBy,
    mode: approval.mode,
    status: approval.status,
    call: approval.call,
    createdAt: toIsoString(approval.createdAt),
    expiresAt: toIsoString(approval.expiresAt),
    decidedAt: approval.decidedAt ? toIsoString(approval.decidedAt) : undefined,
    decidedBy: approval.decidedBy,
    outcome: approval.outcome,
    reported: approval.reportedInMessageId !== undefined,
  })
}

/** Approval modes and held calls. Session routes only, and never on the agent API gateway. */
export function registerAgentApprovalRoutes(app: Elysia, host: SixbHostView) {
  const missingStorage = (set: { status?: number | string }) =>
    unconfiguredStorageResponse(set, "Agent storage")

  return app
    .get(
      "/api/agent/preferences",
      async (context) => {
        const { set } = context
        try {
          if (!host.storage.agents) return missingStorage(set)
          return AgentPreferencesSchema.parse(
            await requireRequestSixb(context).agent.preferences.get()
          )
        } catch (error) {
          return handleAgentRouteError(error, set)
        }
      },
      {
        response: {
          200: AgentPreferencesSchema,
          404: AgentRequestErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "Get your Agent preferences",
          tags: [OPENAPI_TAGS.agents.name],
          operationId: "getAgentPreferences",
        },
      }
    )
    .put(
      "/api/agent/preferences",
      async (context) => {
        const { body, set } = context
        try {
          if (!host.storage.agents) return missingStorage(set)
          const parsed = AgentPreferencesBodySchema.parse(body)
          return AgentPreferencesSchema.parse(
            await requireRequestSixb(context).agent.preferences.update(parsed)
          )
        } catch (error) {
          return handleAgentRouteError(error, set)
        }
      },
      {
        body: AgentPreferencesBodySchema,
        response: {
          200: AgentPreferencesSchema,
          400: AgentRequestErrorResponseSchema,
          404: AgentRequestErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "Update your Agent preferences",
          description:
            "`approvalMode` is your default in the threads where you chose none: `manual` asks before every action and workflow, `accept-edits` runs the actions that only change Sixb, `auto` runs everything.",
          tags: [OPENAPI_TAGS.agents.name],
          operationId: "updateAgentPreferences",
          security: SIXB_SESSION_MUTATION_SECURITY_REQUIREMENT,
        },
      }
    )
    .put(
      "/api/agent-threads/:threadId/approval-mode",
      async (context) => {
        const { params, body, set } = context
        const sixb = requireRequestSixb(context)
        try {
          if (!host.storage.agents) return missingStorage(set)
          const parsed = AgentThreadApprovalModeBodySchema.parse(body)
          const approvalMode = await sixb.agent.threads.setApprovalMode(
            params.threadId,
            parsed.approvalMode
          )
          const thread = await sixb.agent.threads.getById(params.threadId)
          if (!thread) {
            set.status = 404
            return { error: "Agent thread not found" }
          }

          return { ...(await serializeThread(host, thread)), ...approvalMode }
        } catch (error) {
          return handleAgentRouteError(error, set)
        }
      },
      {
        params: AgentThreadParamsSchema,
        body: AgentThreadApprovalModeBodySchema,
        response: {
          200: AgentThreadSchema,
          400: AgentRequestErrorResponseSchema,
          404: AgentRequestErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "Choose your approval mode in an agent thread",
          description:
            "Applies to your next turns in the thread; other participants keep theirs. `null` follows your default again. A message can still pass its own `approvalMode`.",
          tags: [OPENAPI_TAGS.agentThreads.name],
          operationId: "setAgentThreadApprovalMode",
          security: SIXB_SESSION_MUTATION_SECURITY_REQUIREMENT,
        },
      }
    )
    .get(
      "/api/agent-threads/:threadId/approvals",
      async (context) => {
        const { params, query, set } = context
        const sixb = requireRequestSixb(context)
        try {
          if (!host.storage.agents) return missingStorage(set)
          if (!(await sixb.agent.threads.getById(params.threadId))) {
            set.status = 404
            return { error: "Agent thread not found" }
          }

          const parsed = AgentApprovalListQuerySchema.parse(query)
          const result = await sixb.agent.approvals.list({
            threadId: params.threadId,
            ...(parsed.runId === undefined ? {} : { runId: parsed.runId }),
            ...(parsed.status === undefined ? {} : { statuses: [parsed.status] }),
            limit: parseOptionalInt(parsed.limit),
            offset: parseOptionalInt(parsed.offset),
          })
          return AgentApprovalListResponseSchema.parse({
            ...result,
            approvals: result.approvals.map(serializeApproval),
          })
        } catch (error) {
          return handleAgentRouteError(error, set)
        }
      },
      {
        params: AgentThreadParamsSchema,
        query: AgentApprovalListQuerySchema,
        response: {
          200: AgentApprovalListResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "List an agent thread's held calls",
          description: "Oldest first. Whoever reads the thread reads its approvals.",
          tags: [OPENAPI_TAGS.agentThreads.name],
          operationId: "listAgentThreadApprovals",
        },
      }
    )
    .post(
      "/api/agent-threads/:threadId/approvals/:approvalId/decision",
      async (context) => {
        const { params, body, set } = context
        const sixb = requireRequestSixb(context)
        try {
          if (!host.storage.agents) return missingStorage(set)
          const approval = await sixb.agent.approvals.getById(params.approvalId)
          if (!approval || approval.threadId !== params.threadId) {
            set.status = 404
            return { error: "Agent approval not found" }
          }

          const parsed = DecideAgentApprovalBodySchema.parse(body)
          const decided = await sixb.agent.approvals.decide(approval.id, parsed)
          return DecideAgentApprovalResponseSchema.parse({ approval: serializeApproval(decided) })
        } catch (error) {
          return handleAgentRouteError(error, set)
        }
      },
      {
        params: AgentApprovalParamsSchema,
        body: DecideAgentApprovalBodySchema,
        response: {
          200: DecideAgentApprovalResponseSchema,
          400: AgentRequestErrorResponseSchema,
          403: AgentRequestErrorResponseSchema,
          404: ErrorResponseSchema,
          409: AgentRequestErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "Approve or deny a held agent call",
          description: DECIDING,
          tags: [OPENAPI_TAGS.agentRuns.name],
          operationId: "decideAgentApproval",
          security: SIXB_SESSION_MUTATION_SECURITY_REQUIREMENT,
        },
      }
    )
    .get(
      "/api/agent-approvals",
      async (context) => {
        const { query, set } = context
        try {
          if (!host.storage.agents) return missingStorage(set)
          const parsed = MyAgentApprovalListQuerySchema.parse(query)
          const result = await requireRequestSixb(context).agent.approvals.list({
            ...(parsed.status === undefined ? {} : { statuses: [parsed.status] }),
            limit: parseOptionalInt(parsed.limit),
            offset: parseOptionalInt(parsed.offset),
          })
          return AgentApprovalListResponseSchema.parse({
            ...result,
            approvals: result.approvals.map(serializeApproval),
          })
        } catch (error) {
          return handleAgentRouteError(error, set)
        }
      },
      {
        query: MyAgentApprovalListQuerySchema,
        response: {
          200: AgentApprovalListResponseSchema,
          400: ErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "List the calls held for your decision",
          description: "Your own, across threads, oldest first.",
          tags: [OPENAPI_TAGS.agentRuns.name],
          operationId: "listAgentApprovals",
        },
      }
    )
}
