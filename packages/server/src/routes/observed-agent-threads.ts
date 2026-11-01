import type { AgentThreadView, SixbHostView } from "@sixb/core"
import type { Elysia } from "elysia"
import { requestActor, requireRequestSixb } from "../auth/scope"
import { fileContentGetResponses, handleFileContentQueryValidationError } from "../files/content"
import { OPENAPI_TAGS } from "../openapi/tags"
import {
  AgentChildListQuerySchema,
  AgentChildListResponseSchema,
  AgentMessageFileContentParamsSchema,
  AgentMessageListResponseSchema,
  AgentMessagesQuerySchema,
  AgentRunListQuerySchema,
  AgentRunListResponseSchema,
  AgentThreadParamsSchema,
  AgentThreadSchema,
} from "../schemas/agents"
import { ErrorResponseSchema } from "../schemas/common"
import { FileContentQuerySchema } from "../schemas/files"
import { parseOptionalInt, unconfiguredStorageResponse } from "../utils/http"
import {
  AgentChildFileContentQuerySchema,
  agentChildFileContentResponse,
  serializeAgentChild,
} from "./agent-children"
import {
  agentMessageFileContentResponse,
  handleAgentRouteError,
  readThreadMessages,
  serializeAgentRun,
  serializeThread,
} from "./agents"

const errors = {
  400: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  501: ErrorResponseSchema,
}

const OBSERVED =
  "Read-only, whoever owns the thread. Takes can.observe(agent.threads); the response matches the owner's route."

/**
 * Any user's conversation, read-only, with `can.observe(agent.threads)`. These routes are apart
 * from `/api/agent-threads`, which stay the owner's: nothing here writes, and a reader without the
 * grant gets 403 rather than the owner routes' 404.
 */
export function registerObservedAgentThreadRoutes(app: Elysia, host: SixbHostView) {
  return app
    .get(
      "/api/observed-agent-threads/:threadId",
      async (context) => {
        try {
          const thread = await readObservedThread(context)
          if (!host.storage.agents) {
            return unconfiguredStorageResponse(context.set, "Agent storage")
          }
          if (!thread) {
            return threadNotFound(context.set)
          }

          return await serializeThread(host, thread, requestActor(requireRequestSixb(context)))
        } catch (error) {
          return handleAgentRouteError(error, context.set)
        }
      },
      {
        params: AgentThreadParamsSchema,
        response: { 200: AgentThreadSchema, ...errors },
        detail: {
          summary: "Read another user's agent thread",
          description: OBSERVED,
          tags: [OPENAPI_TAGS.agentThreads.name],
          operationId: "getObservedAgentThread",
        },
      }
    )
    .get(
      "/api/observed-agent-threads/:threadId/messages",
      async (context) => {
        try {
          const thread = await readObservedThread(context)
          const storage = host.storage.agents
          if (!storage) {
            return unconfiguredStorageResponse(context.set, "Agent storage")
          }
          if (!thread) {
            return threadNotFound(context.set)
          }

          const query = AgentMessagesQuerySchema.parse(context.query)
          return AgentMessageListResponseSchema.parse(
            await readThreadMessages(host, storage, thread, query)
          )
        } catch (error) {
          return handleAgentRouteError(error, context.set)
        }
      },
      {
        params: AgentThreadParamsSchema,
        query: AgentMessagesQuerySchema,
        response: { 200: AgentMessageListResponseSchema, ...errors },
        detail: {
          summary: "List another user's agent thread messages",
          description: `${OBSERVED} \`authors\` names who wrote the page's messages.`,
          tags: [OPENAPI_TAGS.agentThreads.name],
          operationId: "listObservedAgentThreadMessages",
        },
      }
    )
    .get(
      "/api/observed-agent-threads/:threadId/messages/:messageId/files/content",
      async (context) => {
        try {
          const thread = await readObservedThread(context)
          return await agentMessageFileContentResponse(host, context, {
            readThread: async () => thread,
          })
        } catch (error) {
          return handleAgentRouteError(error, context.set)
        }
      },
      {
        params: AgentMessageFileContentParamsSchema,
        query: FileContentQuerySchema,
        detail: {
          summary: "Get a file of another user's agent message",
          description: OBSERVED,
          tags: [OPENAPI_TAGS.agentThreads.name],
          operationId: "getObservedAgentMessageFileContent",
          responses: fileContentGetResponses({ optionalStorage: true }),
        },
      }
    )
    .get(
      "/api/observed-agent-threads/:threadId/runs",
      async (context) => {
        try {
          const thread = await readObservedThread(context)
          if (!host.storage.agents) {
            return unconfiguredStorageResponse(context.set, "Agent storage")
          }
          if (!thread) {
            return threadNotFound(context.set)
          }

          const query = AgentRunListQuerySchema.parse(context.query)
          const result = await requireRequestSixb(context).agent.observed.listRuns(
            context.params.threadId,
            {
              statuses: query.status ? [query.status] : undefined,
              limit: parseOptionalInt(query.limit),
              offset: parseOptionalInt(query.offset),
              order: query.order,
            }
          )
          if (!result) {
            return threadNotFound(context.set)
          }

          return AgentRunListResponseSchema.parse({
            runs: result.runs.map(serializeAgentRun),
            hasMore: result.hasMore,
            total: result.total,
          })
        } catch (error) {
          return handleAgentRouteError(error, context.set)
        }
      },
      {
        params: AgentThreadParamsSchema,
        query: AgentRunListQuerySchema,
        response: { 200: AgentRunListResponseSchema, ...errors },
        detail: {
          summary: "List another user's agent thread runs",
          description: OBSERVED,
          tags: [OPENAPI_TAGS.agentRuns.name],
          operationId: "listObservedAgentThreadRuns",
        },
      }
    )
    .get(
      "/api/observed-agent-threads/:threadId/children",
      async (context) => {
        try {
          const query = AgentChildListQuerySchema.parse(context.query)
          const result = await requireRequestSixb(context).agent.observed.listChildren(
            context.params.threadId,
            query.runId === undefined ? {} : { runId: query.runId }
          )
          if (!host.storage.agents) {
            return unconfiguredStorageResponse(context.set, "Agent storage")
          }
          if (!result) {
            return threadNotFound(context.set)
          }

          return AgentChildListResponseSchema.parse({
            children: result.children.map(serializeAgentChild),
          })
        } catch (error) {
          return handleAgentRouteError(error, context.set)
        }
      },
      {
        params: AgentThreadParamsSchema,
        query: AgentChildListQuerySchema,
        response: { 200: AgentChildListResponseSchema, ...errors },
        detail: {
          summary: "List the sub-agents of another user's agent conversation",
          description: OBSERVED,
          tags: [OPENAPI_TAGS.agentThreads.name],
          operationId: "listObservedAgentThreadChildren",
        },
      }
    )
    .get(
      "/api/observed-agent-threads/:threadId/child-files/content",
      async (context) => {
        try {
          return await agentChildFileContentResponse(host, context, () =>
            requireRequestSixb(context).agent.observed.getChild(context.params.threadId)
          )
        } catch (error) {
          return handleAgentRouteError(error, context.set)
        }
      },
      {
        params: AgentThreadParamsSchema,
        query: AgentChildFileContentQuerySchema,
        error: handleFileContentQueryValidationError,
        detail: {
          summary: "Get a file of another user's sub-agent",
          description: OBSERVED,
          tags: [OPENAPI_TAGS.agentThreads.name],
          operationId: "getObservedAgentChildFileContent",
          responses: fileContentGetResponses({ optionalStorage: true }),
        },
      }
    )
}

/** The thread, read as an observer: this authorizes, so a refusal comes before anything else. */
function readObservedThread(context: {
  readonly params: { readonly threadId: string }
}): Promise<AgentThreadView | null> {
  return requireRequestSixb(context).agent.observed.getById(context.params.threadId)
}

function threadNotFound(set: { status?: number | string }) {
  set.status = 404
  return { error: "Agent thread not found" }
}
