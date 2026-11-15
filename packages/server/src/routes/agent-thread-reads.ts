import type { SixbHostView } from "@sixb/core"
import type { Elysia } from "elysia"
import { requireRequestSixb } from "../auth/scope"
import { SIXB_SESSION_MUTATION_SECURITY_REQUIREMENT } from "../openapi/security"
import { OPENAPI_TAGS } from "../openapi/tags"
import {
  AgentRequestErrorResponseSchema,
  AgentThreadParamsSchema,
  MarkAgentThreadReadBodySchema,
  MarkAgentThreadReadResponseSchema,
} from "../schemas/agents"
import { ErrorResponseSchema } from "../schemas/common"
import { toIsoString, unconfiguredStorageResponse } from "../utils/http"
import { handleAgentRouteError } from "./agents"

const MARKING =
  "Record that your reading of a conversation reached a message, or its newest when `throughSeq` is omitted, which is what a Done button sends. It never moves backwards, so another device that read further keeps its place. Session routes only: a runner has no reading."

/** Where the caller's reading of a conversation has reached. One route: the write. */
export function registerAgentThreadReadRoutes(app: Elysia, host: SixbHostView) {
  return app.put(
    "/api/agent/thread-reads/:threadId",
    async (context) => {
      const { set } = context
      try {
        if (!host.storage.agents) {
          return unconfiguredStorageResponse(set, "Agent storage")
        }

        const body = MarkAgentThreadReadBodySchema.parse(context.body ?? {})
        const read = await requireRequestSixb(context).agent.threads.markRead(
          context.params.threadId,
          body
        )

        return MarkAgentThreadReadResponseSchema.parse({
          read: {
            threadId: read.threadId,
            throughSeq: read.throughSeq,
            headSeq: read.headSeq,
            unread: read.unread,
            readAt: read.readAt ? toIsoString(read.readAt) : undefined,
          },
        })
      } catch (error) {
        return handleAgentRouteError(error, set)
      }
    },
    {
      params: AgentThreadParamsSchema,
      body: MarkAgentThreadReadBodySchema,
      response: {
        200: MarkAgentThreadReadResponseSchema,
        400: AgentRequestErrorResponseSchema,
        404: AgentRequestErrorResponseSchema,
        501: ErrorResponseSchema,
      },
      detail: {
        summary: "Mark how far you have read an Agent thread",
        description: MARKING,
        tags: [OPENAPI_TAGS.agentThreads.name],
        operationId: "markAgentThreadRead",
        security: SIXB_SESSION_MUTATION_SECURITY_REQUIREMENT,
      },
    }
  )
}
