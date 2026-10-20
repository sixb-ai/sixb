import type { SixbHostView } from "@sixb/core"
import type {
  AgentMessageRecord,
  AgentThreadRecord,
  AuthStorage,
  Principal,
} from "@sixb/core/storage"
import type { Elysia } from "elysia"
import { requireRequestSixb } from "../auth/scope"
import { fileContentGetResponses } from "../files/content"
import { OPENAPI_TAGS } from "../openapi/tags"
import {
  AgentMessageFileContentParamsSchema,
  AgentMessagesQuerySchema,
  AgentRunListQuerySchema,
  AgentRunListResponseSchema,
  AgentThreadParamsSchema,
  AgentThreadSchema,
  ObservedAgentMessageListResponseSchema,
} from "../schemas/agents"
import { ErrorResponseSchema } from "../schemas/common"
import { FileContentQuerySchema } from "../schemas/files"
import { parseOptionalInt, unconfiguredStorageResponse } from "../utils/http"
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

          return serializeThread(thread)
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
          const page = await readThreadMessages(host.id, storage, thread, query)
          const authors = await readAuthors(host.id, host.storage.auth, page.messages)

          return ObservedAgentMessageListResponseSchema.parse({ ...page, authors })
        } catch (error) {
          return handleAgentRouteError(error, context.set)
        }
      },
      {
        params: AgentThreadParamsSchema,
        query: AgentMessagesQuerySchema,
        response: { 200: ObservedAgentMessageListResponseSchema, ...errors },
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
}

/** The thread, read as an observer: this authorizes, so a refusal comes before anything else. */
function readObservedThread(context: {
  readonly params: { readonly threadId: string }
}): Promise<AgentThreadRecord | null> {
  return requireRequestSixb(context).agent.observed.getById(context.params.threadId)
}

function threadNotFound(set: { status?: number | string }) {
  set.status = 404
  return { error: "Agent thread not found" }
}

/** The page's distinct authors; an account adds its display name and nothing else of its profile. */
async function readAuthors(
  projectId: string,
  auth: AuthStorage | undefined,
  messages: readonly Pick<AgentMessageRecord, "authorPrincipal">[]
) {
  const authors = new Map<string, Principal>()
  for (const { authorPrincipal } of messages) {
    if (authorPrincipal) {
      authors.set(`${authorPrincipal.type}:${authorPrincipal.id}`, authorPrincipal)
    }
  }

  return Promise.all(
    [...authors.values()].map(async (principal) => {
      const user =
        principal.type === "user"
          ? await auth?.users.getById({ projectId, id: principal.id })
          : null

      return {
        type: principal.type,
        id: principal.id,
        ...(user?.displayName ? { displayName: user.displayName } : {}),
      }
    })
  )
}
