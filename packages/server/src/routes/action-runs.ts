import type { SixbHostView } from "@sixb/core"
import type { ActionRunRecord } from "@sixb/core/storage"
import type { Elysia } from "elysia"
import { z } from "zod"
import { bearerSecurityRequirement } from "../auth/access-token-boundary"
import { requireRequestSixb } from "../auth/scope"
import {
  createContextualFileContentResponse,
  fileContentGetResponses,
  fileContentHeadResponses,
  handleFileContentQueryValidationError,
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
      ? run.writeback.status === "succeeded"
        ? {
            status: "succeeded",
            completedAt: toIsoString(run.writeback.completedAt),
            result: run.writeback.result,
          }
        : {
            status: "failed",
            completedAt: toIsoString(run.writeback.completedAt),
            error: run.writeback.error,
          }
      : undefined,
    effects: run.effects
      ? run.effects.status === "succeeded"
        ? {
            status: "succeeded",
            completedAt: toIsoString(run.effects.completedAt),
          }
        : {
            status: "failed",
            completedAt: toIsoString(run.effects.completedAt),
            error: run.effects.error,
          }
      : undefined,
  })
}

async function actionRunFileContentResponse(
  host: SixbHostView,
  context: {
    readonly params: { readonly runId: string }
    readonly query: unknown
    readonly request: Request
    readonly set: { status?: number | string }
  },
  options: { readonly head?: boolean } = {}
) {
  const sixb = requireRequestSixb(context)

  const storage = host.storage.actionRuns
  if (!storage) {
    return unconfiguredStorageResponse(context.set, "Action run storage")
  }

  return createContextualFileContentResponse({
    blobStorage: host.blobStorage,
    query: context.query,
    querySchema: ActionRunFileContentQuerySchema,
    request: context.request,
    set: context.set,
    head: options.head,
    resolveRoot: async () => {
      const run = await sixb.actions.runs.getById(context.params.runId)
      return run ? serializeActionRunDetail(run) : null
    },
  })
}

export function registerActionRunRoutes(app: Elysia, host: SixbHostView) {
  return app
    .get(
      "/api/action-runs",
      async (context) => {
        const { query, set } = context
        const sixb = requireRequestSixb(context)
        try {
          const storage = host.storage.actionRuns
          if (!storage) {
            return unconfiguredStorageResponse(set, "Action run storage")
          }

          const parsed = ActionRunsQuerySchema.parse(query)
          const limit = parseOptionalInt(parsed.limit)
          const offset = parseOptionalInt(parsed.offset)
          const result = await sixb.actions.runs.list({
            actionId: parsed.actionId,
            objectTypeId: parsed.objectTypeId,
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
        const sixb = requireRequestSixb(context)
        try {
          const storage = host.storage.actionRuns
          if (!storage) {
            return unconfiguredStorageResponse(set, "Action run storage")
          }

          const run = await sixb.actions.runs.getById(params.runId)
          if (!run) {
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
      (context) => actionRunFileContentResponse(host, context),
      {
        params: ActionRunIdParamsSchema,
        query: ActionRunFileContentQuerySchema,
        error: handleFileContentQueryValidationError,
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
      (context) => actionRunFileContentResponse(host, context, { head: true }),
      {
        params: ActionRunIdParamsSchema,
        query: ActionRunFileContentQuerySchema,
        error: handleFileContentQueryValidationError,
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
