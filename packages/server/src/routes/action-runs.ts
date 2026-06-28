import { type ActionRunRecord, canViewActionRun, type OntologySource, type Sixb } from "@sixb/core"
import type { Elysia } from "elysia"
import { bearerSecurityRequirement } from "../auth/access-token-boundary"
import { requestAuthState } from "../auth/scope"
import {
  ActionRunDetailSchema,
  ActionRunIdParamsSchema,
  ActionRunListResponseSchema,
  ActionRunSummarySchema,
  ActionRunsQuerySchema,
} from "../schemas/actions"
import { ErrorResponseSchema } from "../schemas/common"
import { handleRouteError, parseDate, parseOptionalInt, toIsoString } from "../utils/http"

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
          tags: ["Actions"],
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
          tags: ["Actions"],
          operationId: "getActionRun",
          security: bearerSecurityRequirement("getActionRun"),
        },
      }
    )
}
