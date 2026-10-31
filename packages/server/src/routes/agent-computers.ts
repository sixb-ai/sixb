import { AgentRequestError, principalsEqual, type SixbHostView } from "@sixb/core"
import type { AgentRunSessionHost } from "@sixb/core/internal/agents"
import type { ConversationAgentRunRecord } from "@sixb/core/storage"
import type { Elysia } from "elysia"
import { requestActor, requireRequestSixb } from "../auth/scope"
import { SIXB_SESSION_MUTATION_SECURITY_REQUIREMENT } from "../openapi/security"
import { OPENAPI_TAGS } from "../openapi/tags"
import {
  AgentRequestErrorResponseSchema,
  AgentThreadParamsSchema,
  AgentThreadSchema,
  MoveAgentThreadToComputerBodySchema,
} from "../schemas/agents"
import { ErrorResponseSchema } from "../schemas/common"
import { unconfiguredStorageResponse } from "../utils/http"
import { handleAgentRouteError, serializeThread } from "./agents"

// A computer's thread runs on one of its owner's computers: the first that claims one of its
// turns, until its owner moves it to another. Each claim names the computer it comes from, so two
// computers of the same person never both run its turns.

/**
 * Why a computer's turn is not this computer's to claim, or null when it is. A thread no computer
 * runs yet is assigned the one claiming its first turn.
 */
export async function refuseOtherComputer(
  sessions: AgentRunSessionHost,
  run: ConversationAgentRunRecord,
  body: unknown
): Promise<{ readonly status: 400 | 403; readonly error: Record<string, string> } | null> {
  const computerId = (body as { readonly computerId?: unknown } | null)?.computerId
  if (typeof computerId !== "string" || computerId.trim() === "") {
    return {
      status: 400,
      error: {
        kind: "Error",
        message: "[SixbServer] A claim of a computer's turn names the computer it comes from.",
      },
    }
  }

  const { threads } = sessions.storage.agents
  const thread = await threads.getById({ projectId: run.projectId, id: run.threadId })
  const assigned =
    thread?.computerId ??
    (
      await threads.assignComputer({
        projectId: run.projectId,
        id: run.threadId,
        computerId,
        ifUnassigned: true,
      })
    ).computerId
  if (assigned === computerId) return null

  return {
    status: 403,
    error: {
      kind: "AgentRunRefusedError",
      message: `[SixbServer] Agent thread '${run.threadId}' runs on another of your computers: move it to this one to run its turns here.`,
    },
  }
}

export function registerAgentComputerRoutes(app: Elysia, host: SixbHostView) {
  return app.post(
    "/api/agent-threads/:threadId/computer",
    async (context) => {
      const { params, body, set } = context
      const sixb = requireRequestSixb(context)
      try {
        const agents = host.storage.agents
        if (!agents) return unconfiguredStorageResponse(set, "Agent storage")

        const { computerId } = MoveAgentThreadToComputerBodySchema.parse(body)
        const thread = await sixb.agent.threads.getById(params.threadId)
        if (!thread) {
          throw new AgentRequestError(
            "thread_not_found",
            `[SixbServer] Agent thread '${params.threadId}' not found.`
          )
        }
        if (!principalsEqual(thread.ownerPrincipal, requestActor(sixb))) {
          throw new AgentRequestError(
            "not_thread_owner",
            `[SixbServer] Only the owner of Agent thread '${params.threadId}' moves it to a computer.`
          )
        }
        if (thread.runsOn !== "computer") {
          throw new AgentRequestError(
            "invalid_message",
            `[SixbServer] Agent thread '${params.threadId}' runs in the cloud, on no computer.`
          )
        }

        const moved = await agents.threads.assignComputer({
          projectId: host.id,
          id: params.threadId,
          computerId,
        })
        return serializeThread(host, { ...moved, participants: thread.participants })
      } catch (error) {
        return handleAgentRouteError(error, set)
      }
    },
    {
      params: AgentThreadParamsSchema,
      body: MoveAgentThreadToComputerBodySchema,
      response: {
        200: AgentThreadSchema,
        400: AgentRequestErrorResponseSchema,
        403: AgentRequestErrorResponseSchema,
        404: AgentRequestErrorResponseSchema,
        501: ErrorResponseSchema,
      },
      detail: {
        summary: "Move a thread to another of your computers",
        description:
          "A thread that runs on its owner's computer runs there alone: its turns are claimed by that computer only. Its owner moves it to another.",
        tags: [OPENAPI_TAGS.agentThreads.name],
        operationId: "moveAgentThreadToComputer",
        security: SIXB_SESSION_MUTATION_SECURITY_REQUIREMENT,
      },
    }
  )
}
