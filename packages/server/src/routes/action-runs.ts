import type { OntologySource, Sixb } from "@sixb/core"
import { canViewActionRun } from "@sixb/core/internal/authorization"
import type { ActionRunRecord } from "@sixb/core/storage"
import type { Elysia } from "elysia"
import { z } from "zod"
import { bearerSecurityRequirement } from "../auth/access-token-boundary"
import { requestAuthState } from "../auth/scope"
import {
  createContextualFileContentResponse,
  fileContentGetResponses,
  fileContentHeadResponses,
} from "../files/content"
import { OPENAPI_TAGS } from "../openapi/tags"
import {
  ActionRunDetailSchema,
  ActionRunIdParamsSchema,
  ActionRunListResponseSchema,
  ActionRunSummarySchema,
  ActionRunsQuerySchema,
} from "../schemas/actions"
import { ErrorResponseSchema } from "../schemas/common"
import { FileContentQuerySchema } from "../schemas/files"
import {
  handleRouteError,
  parseDate,
  parseOptionalInt,
  toIsoString,
  unconfiguredStorageResponse,
} from "../utils/http"

const ActionRunFileContentQuerySchema = FileContentQuerySchema.extend({
  path: z
    .string()
    .min(1)
    .regex(
      /^\/(?:params|writeback\/result)(?:\/|$)/,
      "Action run file content paths must start with /params/ or /writeback/result/"
    ),
})

function serializeActionRunSummary(
  run: ActionRunRecord
): ReturnType<typeof ActionRunSummarySchema.parse> {
  return ActionRunSummarySchema.parse({
    id: run.id,
    projectId: run.projectId,
    actionId: run.actionId,
    subject: run.subject,
    status: run.status,
    phase: run.phase,
    queuedAt: toIsoString(run.queuedAt),
    startedAt: run.startedAt ? toIsoString(run.startedAt) : undefined,
    finishedAt: run.finishedAt ? toIsoString(run.finishedAt) : undefined,
    error: run.error,
  })
}

function serializeActionRunDetail(
  run: ActionRunRecord
): ReturnType<typeof ActionRunDetailSchema.parse> {
  return ActionRunDetailSchema.parse({
    ...serializeActionRunSummary(run),
    params: run.params,
    writeback: run.writeback
      ? {
          status: run.writeback.status,
          completedAt: toIsoString(run.writeback.completedAt),
          ...(run.writeback.result !== undefined ? { result: run.writeback.result } : {}),
          error: run.writeback.error,
        }
      : undefined,
    effects: run.effects
      ? {
          status: run.effects.status,
          completedAt: toIsoString(run.effects.completedAt),
          error: run.effects.error,
        }
      : undefined,
  })
}

async function actionRunFileContentResponse(
  sixb: Sixb<readonly OntologySource[]>,
  context: {
    readonly params: { readonly runId: string }
    readonly query: unknown
    readonly request: Request
    readonly set: { status?: number | string }
  },
  options: { readonly head?: boolean } = {}
) {
  const { authz } = requestAuthState(context)

  const storage = sixb.storage.actionRuns
  if (!storage) {
    return unconfiguredStorageResponse(context.set, "Action run storage")
  }

  return createContextualFileContentResponse({
    blobStorage: sixb.blobStorage,
    query: context.query,
    querySchema: ActionRunFileContentQuerySchema,
    request: context.request,
    set: context.set,
    head: options.head,
    resolveRoot: async () => {
      const run = await storage.getById({ projectId: sixb.id, id: context.params.runId })
      if (!run || !canViewActionRun(authz, run)) {
        return null
      }

      return serializeActionRunDetail(run)
    },
  })
}

export function registerActionRunRoutes(app: Elysia, sixb: Sixb<readonly OntologySource[]>) {
  return app
    .get(
      "/api/action-runs",
      async (context) => {
        const { query, set } = context
        const { authz } = requestAuthState(context)
        try {
          const storage = sixb.storage.actionRuns
          if (!storage) {
            return unconfiguredStorageResponse(set, "Action run storage")
          }

          const parsed = ActionRunsQuerySchema.parse(query)
          const limit = parseOptionalInt(parsed.limit)
          const offset = parseOptionalInt(parsed.offset)
          const actionIds = authz ? [...authz.grants["apply:action"]] : undefined
          const objectTypeIds = authz ? [...authz.grants["view:object"]] : undefined
          const result = await storage.list({
            projectId: sixb.id,
            actionId: parsed.actionId,
            actionIds,
            objectTypeId: parsed.objectTypeId,
            objectTypeIds,
            primaryId: parsed.primaryId,
            statuses: parsed.status ? [parsed.status] : undefined,
            startedAfter: parseDate(parsed.startedAfter),
            startedBefore: parseDate(parsed.startedBefore),
            limit,
            offset,
            order: parsed.order,
          })

          return ActionRunListResponseSchema.parse({
            runs: result.runs.map(serializeActionRunSummary),
            hasMore: result.hasMore,
            total: result.total,
          })
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        query: ActionRunsQuerySchema,
        response: {
          200: ActionRunListResponseSchema,
          400: ErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "List action run history",
          tags: [OPENAPI_TAGS.actionRuns.name],
          operationId: "listActionRuns",
          security: bearerSecurityRequirement("listActionRuns"),
        },
      }
    )
    .get(
      "/api/action-runs/:runId",
      async (context) => {
        const { params, set } = context
        const { authz } = requestAuthState(context)
        try {
          const storage = sixb.storage.actionRuns
          if (!storage) {
            return unconfiguredStorageResponse(set, "Action run storage")
          }

          const run = await storage.getById({ projectId: sixb.id, id: params.runId })
          if (!run || !canViewActionRun(authz, run)) {
            set.status = 404
            return { error: "Action run not found" }
          }

          return serializeActionRunDetail(run)
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        params: ActionRunIdParamsSchema,
        response: {
          200: ActionRunDetailSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "Get action run detail",
          tags: [OPENAPI_TAGS.actionRuns.name],
          operationId: "getActionRun",
          security: bearerSecurityRequirement("getActionRun"),
        },
      }
    )
    .get(
      "/api/action-runs/:runId/files/content",
      (context) => actionRunFileContentResponse(sixb, context),
      {
        params: ActionRunIdParamsSchema,
        query: FileContentQuerySchema,
        detail: {
          summary: "Get action run file content",
          tags: ["Actions"],
          operationId: "getActionRunFileContent",
          security: bearerSecurityRequirement("getActionRunFileContent"),
          responses: fileContentGetResponses({ optionalStorage: true }),
        },
      }
    )
    .head(
      "/api/action-runs/:runId/files/content",
      (context) => actionRunFileContentResponse(sixb, context, { head: true }),
      {
        params: ActionRunIdParamsSchema,
        query: FileContentQuerySchema,
        detail: {
          summary: "Head action run file content",
          tags: ["Actions"],
          operationId: "headActionRunFileContent",
          security: bearerSecurityRequirement("headActionRunFileContent"),
          responses: fileContentHeadResponses({ optionalStorage: true }),
        },
      }
    )
}
