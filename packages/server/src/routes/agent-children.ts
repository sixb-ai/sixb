import type { AgentChildRunView, AgentChildView, SixbHostView } from "@sixb/core"
import { agentRunStreamId } from "@sixb/core/internal/agents/streams"
import type { Elysia } from "elysia"
import { z } from "zod"
import { accessTokenSecurityRequirement } from "../auth/access-token-boundary"
import { requireRequestSixb } from "../auth/scope"
import {
  createContextualFileContentResponse,
  fileContentGetResponses,
  fileContentHeadResponses,
  handleFileContentQueryValidationError,
} from "../files/content"
import { OPENAPI_TAGS } from "../openapi/tags"
import {
  AgentChildListQuerySchema,
  AgentChildListResponseSchema,
  AgentChildSchema,
  AgentThreadParamsSchema,
} from "../schemas/agents"
import { ErrorResponseSchema } from "../schemas/common"
import { FileContentQuerySchema } from "../schemas/files"
import { toIsoString, unconfiguredStorageResponse } from "../utils/http"
import { handleAgentRouteError } from "./agents"

/**
 * A file of one run of a sub-agent: one its parent handed it (`/handedFiles/<n>/fileRef`), or one
 * the run returned from `out/` (`/files/<n>/fileRef`). What a tool showed it is a file of its
 * thread's messages.
 */
export const AgentChildFileContentQuerySchema = FileContentQuerySchema.extend({
  run: z.string().min(1),
  path: z
    .string()
    .min(1)
    .regex(
      /^\/(?:handedFiles|files)(?:\/|$)/,
      "Sub-agent file content paths must start with /handedFiles/ or /files/"
    ),
})

const VISIBILITY =
  "A sub-agent is visible exactly when its conversation is: to the thread's owner and participants; observers read it through the observed routes. What it did is its thread's messages, at `GET /api/agent-threads/:threadId/messages` with its `threadId`."

/** A sub-agent as the lists return it. */
export function serializeAgentChild(
  child: AgentChildView
): ReturnType<typeof AgentChildSchema.parse> {
  return AgentChildSchema.parse({
    id: child.id,
    threadId: child.threadId,
    projectId: child.projectId,
    spawnedBy: child.spawnedBy,
    key: child.key,
    task: child.task,
    model: child.model,
    tier: child.tier,
    reasoning: child.reasoning,
    handedFiles: child.handedFiles,
    status: child.status,
    finishReason: child.finishReason,
    error: child.error,
    awaiting: child.awaiting,
    ended: child.ended,
    activeRunId: child.activeRunId,
    createdAt: toIsoString(child.createdAt),
    completedAt: child.completedAt ? toIsoString(child.completedAt) : undefined,
    usage: child.usage,
    cost: child.cost,
    runs: child.runs.map(serializeAgentChildRun),
  })
}

function serializeAgentChildRun(run: AgentChildRunView) {
  return {
    id: run.id,
    parentRunId: run.parentRunId,
    status: run.status,
    finishReason: run.finishReason,
    error: run.error,
    modelId: run.modelId,
    attempt: run.attempt,
    streamId: agentRunStreamId(run.id),
    createdAt: toIsoString(run.createdAt),
    startedAt: run.startedAt ? toIsoString(run.startedAt) : undefined,
    completedAt: run.completedAt ? toIsoString(run.completedAt) : undefined,
    result: run.result,
    usage: run.usage,
    cost: run.cost,
  }
}

/** A file of a sub-agent's run, read through whoever may read the sub-agent. */
export function agentChildFileContentResponse(
  host: SixbHostView,
  context: {
    readonly query: unknown
    readonly request: Request
    readonly set: { status?: number | string }
  },
  readChild: () => Promise<AgentChildView | null>,
  options: { readonly head?: boolean } = {}
) {
  if (!host.storage.agents) {
    return unconfiguredStorageResponse(context.set, "Agent storage")
  }

  return createContextualFileContentResponse({
    blobStorage: host.blobStorage,
    query: context.query,
    querySchema: AgentChildFileContentQuerySchema,
    request: context.request,
    set: context.set,
    head: options.head,
    resolveRoot: async (query) => {
      const child = await readChild()
      const run = child?.runs.find((candidate) => candidate.id === query.run)
      return child && run
        ? { handedFiles: child.handedFiles, files: run.result?.files ?? [] }
        : null
    },
  })
}

/**
 * A conversation's sub-agents, and their files. What one did is its thread's: the thread routes
 * read it, and `/api/agent-runs/:runId` its runs.
 */
export function registerAgentChildRoutes(app: Elysia, host: SixbHostView) {
  const readChild = (context: { readonly params: { readonly threadId: string } }) => () =>
    requireRequestSixb(context).agent.threads.getChild(context.params.threadId)

  return app
    .get(
      "/api/agent-threads/:threadId/children",
      async (context) => {
        const { params, set } = context
        try {
          if (!host.storage.agents) {
            return unconfiguredStorageResponse(set, "Agent storage")
          }

          const query = AgentChildListQuerySchema.parse(context.query)
          const result = await requireRequestSixb(context).agent.threads.listChildren(
            params.threadId,
            query.runId === undefined ? {} : { runId: query.runId }
          )
          if (!result) {
            set.status = 404
            return { error: "Agent thread not found" }
          }

          return AgentChildListResponseSchema.parse({
            children: result.children.map(serializeAgentChild),
          })
        } catch (error) {
          return handleAgentRouteError(error, set)
        }
      },
      {
        params: AgentThreadParamsSchema,
        query: AgentChildListQuerySchema,
        response: {
          200: AgentChildListResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "List the sub-agents of an agent conversation",
          description: `${VISIBILITY} \`runId\` keeps those one turn spawned. Each lists every run it took, the one at work by \`activeRunId\`.`,
          tags: [OPENAPI_TAGS.agentThreads.name],
          operationId: "listAgentThreadChildren",
        },
      }
    )
    .get(
      "/api/agent-threads/:threadId/child-files/content",
      (context) => agentChildFileContentResponse(host, context, readChild(context)),
      {
        params: AgentThreadParamsSchema,
        query: AgentChildFileContentQuerySchema,
        error: handleFileContentQueryValidationError,
        detail: {
          summary: "Get a file of a sub-agent",
          description: `${VISIBILITY} \`threadId\` is the sub-agent's thread, \`run\` one of its runs, and \`path\` points into it: \`/handedFiles/0/fileRef\`, or \`/files/0/fileRef\` for what the run returned.`,
          tags: [OPENAPI_TAGS.agentThreads.name],
          operationId: "getAgentChildFileContent",
          security: accessTokenSecurityRequirement("getAgentChildFileContent"),
          responses: fileContentGetResponses({ optionalStorage: true }),
        },
      }
    )
    .head(
      "/api/agent-threads/:threadId/child-files/content",
      (context) => agentChildFileContentResponse(host, context, readChild(context), { head: true }),
      {
        params: AgentThreadParamsSchema,
        query: AgentChildFileContentQuerySchema,
        error: handleFileContentQueryValidationError,
        detail: {
          summary: "Head a file of a sub-agent",
          tags: [OPENAPI_TAGS.agentThreads.name],
          operationId: "headAgentChildFileContent",
          security: accessTokenSecurityRequirement("headAgentChildFileContent"),
          responses: fileContentHeadResponses({ optionalStorage: true }),
        },
      }
    )
}
