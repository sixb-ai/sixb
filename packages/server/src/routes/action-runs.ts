import { type ActionRunRecord, canViewActionRun, type OntologySource, type Sixb } from "@sixb/core"
import type { Elysia } from "elysia"
import { ZodError, z } from "zod"
import { bearerSecurityRequirement } from "../auth/access-token-boundary"
import { requestAuthState } from "../auth/scope"
import { OPENAPI_TAGS } from "../openapi/tags"
import {
  createFileContentResponse,
  fileContentGetResponses,
  fileContentHeadResponses,
  resolveFileRefAtPath,
} from "../files/content"
import {
  ActionRunDetailSchema,
  ActionRunIdParamsSchema,
  ActionRunListResponseSchema,
  ActionRunSummarySchema,
  ActionRunsQuerySchema,
} from "../schemas/actions"
import { ErrorResponseSchema } from "../schemas/common"
import { FileContentQuerySchema } from "../schemas/files"
import { handleRouteError, parseDate, parseOptionalInt, toIsoString } from "../utils/http"

const ActionRunFileContentQuerySchema = FileContentQuerySchema.extend({
  path: z
    .string()
    .min(1)
    .regex(/^\/params(?:\/|$)/, "Action run file content paths must start with /params/"),
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
    commit: run.commit
      ? {
          committedAt: toIsoString(run.commit.committedAt),
          diff: run.commit.diff,
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

  try {
    const storage = sixb.storage.actionRuns
    if (!storage) {
      context.set.status = 400
      return { error: "Action run storage is not configured" }
    }

    const parsed = ActionRunFileContentQuerySchema.parse(context.query)
    const run = await storage.getById({ projectId: sixb.id, id: context.params.runId })
    if (!run || !canViewActionRun(authz, run)) {
      context.set.status = 404
      return { error: "File not found" }
    }

    const fileRef = resolveFileRefAtPath(serializeActionRunDetail(run), parsed.path)
    if (!fileRef) {
      context.set.status = 404
      return { error: "File not found" }
    }

    const response = await createFileContentResponse({
      blobStorage: sixb.blobStorage,
      fileRef,
      disposition: parsed.disposition,
      head: options.head,
      rangeHeader: context.request.headers.get("range"),
    })
    if (!response) {
      context.set.status = 404
      return { error: "File not found" }
    }

    return response
  } catch (error) {
    if (error instanceof ZodError) {
      context.set.status = 400
      return { error: "Invalid file content query" }
    }

    throw error
  }
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
            set.status = 400
            return { error: "Action run storage is not configured" }
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
        response: { 200: ActionRunListResponseSchema, 400: ErrorResponseSchema },
        detail: {
          summary: "List action run history",
          tags: [OPENAPI_TAGS.actionRuns.name],
          operationId: "listActionRuns",
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
            set.status = 400
            return { error: "Action run storage is not configured" }
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
          responses: fileContentGetResponses(),
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
          responses: fileContentHeadResponses(),
        },
      }
    )
}
