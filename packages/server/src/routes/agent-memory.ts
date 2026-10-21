import { AgentMemoryError, type AgentMemoryRepoName } from "@sixb/core"
import type { Elysia } from "elysia"
import { ZodError } from "zod"
import { accessTokenSecurityRequirement } from "../auth/access-token-boundary"
import { requestAuthState, requireRequestSixb } from "../auth/scope"
import { OPENAPI_TAGS } from "../openapi/tags"
import {
  AgentMemoryConflictResponseSchema,
  AgentMemoryErrorResponseSchema,
  AgentMemoryParamsSchema,
  AgentMemoryRepoResponseSchema,
  AgentMemoryRevisionListQuerySchema,
  AgentMemoryRevisionListResponseSchema,
  DeleteAgentMemoryResponseSchema,
  SaveAgentMemoryBodySchema,
  SavedAgentMemoryResponseSchema,
} from "../schemas/agent-memory"
import { handleRouteError, parseOptionalInt, toIsoString } from "../utils/http"

type RouteSet = { status?: number | string }

function handleAgentMemoryRouteError(error: unknown, set: RouteSet) {
  if (error instanceof AgentMemoryError) {
    switch (error.code) {
      case "invalid_repo":
      case "invalid_save":
        set.status = 400
        break
      case "not_allowed":
        set.status = 403
        break
      case "storage_unavailable":
        set.status = 501
        break
    }
    // The message says what to change, so the Agent can act on it as it is.
    return { error: error.message, code: error.code }
  }
  if (error instanceof ZodError) {
    set.status = 400
    return { error: "Invalid Agent memory request" }
  }
  return handleRouteError(error, set)
}

function repoParam(params: unknown): AgentMemoryRepoName {
  return AgentMemoryParamsSchema.parse(params).repo
}

export function registerAgentMemoryRoutes(app: Elysia) {
  return app
    .get(
      "/api/agent-memory/:repo",
      async (context) => {
        try {
          const repo = await requireRequestSixb(context).agent.memory.get(repoParam(context.params))
          return AgentMemoryRepoResponseSchema.parse(repo)
        } catch (error) {
          return handleAgentMemoryRouteError(error, context.set)
        }
      },
      {
        params: AgentMemoryParamsSchema,
        response: {
          200: AgentMemoryRepoResponseSchema,
          400: AgentMemoryErrorResponseSchema,
          403: AgentMemoryErrorResponseSchema,
          501: AgentMemoryErrorResponseSchema,
        },
        detail: {
          summary: "Get an Agent memory repo",
          description: "Every file of the repo as of its latest revision.",
          tags: [OPENAPI_TAGS.agentMemory.name],
          operationId: "getAgentMemory",
          security: accessTokenSecurityRequirement("getAgentMemory"),
        },
      }
    )
    .get(
      "/api/agent-memory/:repo/revisions",
      async (context) => {
        try {
          const query = AgentMemoryRevisionListQuerySchema.parse(context.query)
          const limit = parseOptionalInt(query.limit)
          const offset = parseOptionalInt(query.offset)
          const result = await requireRequestSixb(context).agent.memory.listRevisions(
            repoParam(context.params),
            {
              ...(limit === undefined ? {} : { limit }),
              ...(offset === undefined ? {} : { offset }),
            }
          )
          return AgentMemoryRevisionListResponseSchema.parse({
            ...result,
            revisions: result.revisions.map((revision) => ({
              ...revision,
              createdAt: toIsoString(revision.createdAt),
            })),
          })
        } catch (error) {
          return handleAgentMemoryRouteError(error, context.set)
        }
      },
      {
        params: AgentMemoryParamsSchema,
        query: AgentMemoryRevisionListQuerySchema,
        response: {
          200: AgentMemoryRevisionListResponseSchema,
          400: AgentMemoryErrorResponseSchema,
          403: AgentMemoryErrorResponseSchema,
          501: AgentMemoryErrorResponseSchema,
        },
        detail: {
          summary: "List an Agent memory repo's revisions",
          description: "Each save is one revision, newest first.",
          tags: [OPENAPI_TAGS.agentMemory.name],
          operationId: "listAgentMemoryRevisions",
          security: accessTokenSecurityRequirement("listAgentMemoryRevisions"),
        },
      }
    )
    .post(
      "/api/agent-memory/:repo/revisions",
      async (context) => {
        try {
          const repo = repoParam(context.params)
          const body = SaveAgentMemoryBodySchema.parse(context.body)
          // The conversation is the run's own, never a value the request supplies.
          const { agentRun } = requestAuthState(context)
          const result = await requireRequestSixb(context).agent.memory.save(repo, {
            ...body,
            ...(agentRun ? { source: `/agents/${agentRun.threadId}` } : {}),
          })
          if (!result.saved) {
            context.set.status = 409
            return AgentMemoryConflictResponseSchema.parse({
              error:
                "Another save changed these files since they were loaded. Merge their contents into yours and save again.",
              code: "conflict",
              revision: result.revision,
              conflicts: result.conflicts,
            })
          }
          context.set.status = 201
          return SavedAgentMemoryResponseSchema.parse({
            repo,
            revision: result.revision,
            warnings: result.warnings,
          })
        } catch (error) {
          return handleAgentMemoryRouteError(error, context.set)
        }
      },
      {
        params: AgentMemoryParamsSchema,
        body: SaveAgentMemoryBodySchema,
        response: {
          201: SavedAgentMemoryResponseSchema,
          400: AgentMemoryErrorResponseSchema,
          403: AgentMemoryErrorResponseSchema,
          409: AgentMemoryConflictResponseSchema,
          501: AgentMemoryErrorResponseSchema,
        },
        detail: {
          summary: "Save changes to an Agent memory repo",
          description:
            "Stores the changes as the repo's next revision. When another save changed one of the files after baseRevision, nothing is saved and the response holds those files as they are now.",
          tags: [OPENAPI_TAGS.agentMemory.name],
          operationId: "saveAgentMemory",
          security: accessTokenSecurityRequirement("saveAgentMemory"),
        },
      }
    )
    .delete(
      "/api/agent-memory/:repo",
      async (context) => {
        try {
          await requireRequestSixb(context).agent.memory.delete(repoParam(context.params))
          return DeleteAgentMemoryResponseSchema.parse({ deleted: true })
        } catch (error) {
          return handleAgentMemoryRouteError(error, context.set)
        }
      },
      {
        params: AgentMemoryParamsSchema,
        response: {
          200: DeleteAgentMemoryResponseSchema,
          400: AgentMemoryErrorResponseSchema,
          403: AgentMemoryErrorResponseSchema,
          501: AgentMemoryErrorResponseSchema,
        },
        detail: {
          summary: "Delete an Agent memory repo",
          description: "Deletes the repo with its history.",
          tags: [OPENAPI_TAGS.agentMemory.name],
          operationId: "deleteAgentMemory",
          security: accessTokenSecurityRequirement("deleteAgentMemory"),
        },
      }
    )
}
