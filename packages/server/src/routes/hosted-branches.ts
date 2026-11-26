import type { BranchView, SixbHostView } from "@sixb/core"
import type { Elysia } from "elysia"
import { requireRequestSixb } from "../auth/scope"
import {
  SIXB_SESSION_MUTATION_SECURITY_REQUIREMENT,
  SIXB_SESSION_SECURITY_REQUIREMENT,
} from "../openapi/security"
import { OPENAPI_TAGS } from "../openapi/tags"
import {
  BranchListResponseSchema,
  BranchNameBodySchema,
  BranchNameQuerySchema,
  BranchSchema,
} from "../schemas/branches"
import { ErrorResponseSchema } from "../schemas/common"
import { handleRouteError } from "../utils/http"

const errors = {
  400: ErrorResponseSchema,
  403: ErrorResponseSchema,
  409: ErrorResponseSchema,
}

/**
 * The branches that run next to production. Each call says what is wanted; the branch worker does
 * the work. A branch's name is in the body or the query, since a git branch name holds slashes.
 */
export function registerHostedBranchRoutes(app: Elysia, _host: SixbHostView) {
  return app
    .get(
      "/api/branches",
      async (context) => {
        try {
          const branches = await requireRequestSixb(context).branches.list()
          return { branches: branches.map(serializeBranch) }
        } catch (error) {
          return handleRouteError(error, context.set)
        }
      },
      {
        response: { 200: BranchListResponseSchema, ...errors },
        detail: {
          summary: "List the branches that run next to production",
          tags: [OPENAPI_TAGS.branches.name],
          operationId: "listBranches",
          security: SIXB_SESSION_SECURITY_REQUIREMENT,
        },
      }
    )
    .post(
      "/api/branches",
      async (context) => {
        try {
          const branch = await requireRequestSixb(context).branches.open(context.body.name)

          context.set.status = 202
          return serializeBranch(branch)
        } catch (error) {
          return handleRouteError(error, context.set)
        }
      },
      {
        body: BranchNameBodySchema,
        response: { 202: BranchSchema, ...errors },
        detail: {
          summary: "Open a git branch next to production, on a copy of what you read",
          tags: [OPENAPI_TAGS.branches.name],
          operationId: "openBranch",
          security: SIXB_SESSION_MUTATION_SECURITY_REQUIREMENT,
        },
      }
    )
    .post(
      "/api/branches/refresh",
      async (context) => {
        try {
          const branch = await requireRequestSixb(context).branches.refresh(context.body.name)

          context.set.status = 202
          return serializeBranch(branch)
        } catch (error) {
          return handleRouteError(error, context.set)
        }
      },
      {
        body: BranchNameBodySchema,
        response: { 202: BranchSchema, ...errors },
        detail: {
          summary: "Take a new copy of production for a branch, discarding what it wrote",
          tags: [OPENAPI_TAGS.branches.name],
          operationId: "refreshBranch",
          security: SIXB_SESSION_MUTATION_SECURITY_REQUIREMENT,
        },
      }
    )
    .post(
      "/api/branches/stop",
      async (context) => {
        try {
          const branch = await requireRequestSixb(context).branches.stop(context.body.name)

          context.set.status = 202
          return serializeBranch(branch)
        } catch (error) {
          return handleRouteError(error, context.set)
        }
      },
      {
        body: BranchNameBodySchema,
        response: { 202: BranchSchema, ...errors },
        detail: {
          summary: "Stop a branch's runtime; its copy stays",
          tags: [OPENAPI_TAGS.branches.name],
          operationId: "stopBranch",
          security: SIXB_SESSION_MUTATION_SECURITY_REQUIREMENT,
        },
      }
    )
    .delete(
      "/api/branches",
      async (context) => {
        try {
          const branch = await requireRequestSixb(context).branches.delete(context.query.name)

          context.set.status = 202
          return serializeBranch(branch)
        } catch (error) {
          return handleRouteError(error, context.set)
        }
      },
      {
        query: BranchNameQuerySchema,
        response: { 202: BranchSchema, ...errors },
        detail: {
          summary: "Delete a branch: its sandbox, its schema and its role",
          tags: [OPENAPI_TAGS.branches.name],
          operationId: "deleteBranch",
          security: SIXB_SESSION_MUTATION_SECURITY_REQUIREMENT,
        },
      }
    )
}

function serializeBranch(branch: BranchView) {
  return {
    ...branch,
    notices: branch.notices.map((notice) => ({ ...notice })),
    data: branch.data && {
      ...branch.data,
      takenAt: branch.data.takenAt.toISOString(),
      skipped: branch.data.skipped.map((skip) => ({ ...skip })),
    },
    refreshRequestedAt: branch.refreshRequestedAt?.toISOString() ?? null,
    openedAt: branch.openedAt.toISOString(),
    lastSeenAt: branch.lastSeenAt.toISOString(),
  }
}
