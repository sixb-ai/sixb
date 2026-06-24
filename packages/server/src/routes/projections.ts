import {
  canViewProjection,
  canViewProjectionRun,
  type OntologySource,
  type ProjectionRunRecord,
  type Sixb,
} from "@sixb/core"
import type { Elysia } from "elysia"
import { requestAuthState } from "../auth/scope"
import { ErrorResponseSchema } from "../schemas/common"
import {
  ProjectionListResponseSchema,
  ProjectionParamsSchema,
  ProjectionResponseSchema,
  ProjectionRunListResponseSchema,
  ProjectionRunParamsSchema,
  ProjectionRunSchema,
  ProjectionRunsQuerySchema,
} from "../schemas/projections"
import { handleRouteError, parseDate, parseOptionalInt, toIsoString } from "../utils/http"

function serializeProjectionRun(run: ProjectionRunRecord) {
  return {
    ...run,
    startedAt: toIsoString(run.startedAt),
    finishedAt: run.finishedAt ? toIsoString(run.finishedAt) : undefined,
  }
}

type SerializedProjectionRun = ReturnType<typeof serializeProjectionRun>

async function getLatestProjectionRuns(
  sixb: Sixb<readonly OntologySource[]>,
  projectionIds: readonly string[]
): Promise<Map<string, SerializedProjectionRun>> {
  const storage = sixb.storage.projectionRuns
  if (!storage || projectionIds.length === 0) {
    return new Map()
  }

  const result = await storage.listLatestByProjectionIds({ projectId: sixb.id, projectionIds })
  return new Map(result.runs.map((run) => [run.projectionId, serializeProjectionRun(run)]))
}

export function registerProjectionRoutes(app: Elysia, sixb: Sixb<readonly OntologySource[]>) {
  return app
    .get(
      "/api/projections",
      async (context) => {
        const { authz } = requestAuthState(context)
        const objectProjections = sixb
          .getObjectProjections()
          .filter((p) => canViewProjection(authz, p))
        const linkProjections = sixb.getLinkProjections().filter((p) => canViewProjection(authz, p))
        const telemetryProjections = sixb
          .getTelemetryProjections()
          .filter((p) => canViewProjection(authz, p))

        const ids = [...objectProjections, ...linkProjections, ...telemetryProjections].map(
          (p) => p.id
        )
        const latestRuns = await getLatestProjectionRuns(sixb, ids)
        const withLatestRun = <T extends { id: string }>(projection: T) => ({
          ...projection,
          latestRun: latestRuns.get(projection.id) ?? null,
        })

        return {
          objectProjections: objectProjections.map(withLatestRun),
          linkProjections: linkProjections.map(withLatestRun),
          telemetryProjections: telemetryProjections.map(withLatestRun),
        }
      },
      {
        response: { 200: ProjectionListResponseSchema },
        detail: {
          summary: "List all projection definitions",
          tags: ["Projections"],
          operationId: "listProjections",
        },
      }
    )
    .get(
      "/api/projections/:projectionId",
      async (context) => {
        const { params, set } = context
        const { authz } = requestAuthState(context)
        const found = sixb.getProjectionById(params.projectionId)
        if (!found || !canViewProjection(authz, found)) {
          set.status = 404
          return { error: `Projection '${params.projectionId}' not found` }
        }

        const latestRuns = await getLatestProjectionRuns(sixb, [found.id])
        return { ...found, latestRun: latestRuns.get(found.id) ?? null }
      },
      {
        params: ProjectionParamsSchema,
        response: { 200: ProjectionResponseSchema, 404: ErrorResponseSchema },
        detail: {
          summary: "Get a projection definition by id",
          tags: ["Projections"],
          operationId: "getProjection",
        },
      }
    )
    .get(
      "/api/projection-runs",
      async (context) => {
        const { query, set } = context
        const { authz } = requestAuthState(context)
        try {
          const storage = sixb.storage.projectionRuns
          if (!storage) {
            set.status = 400
            return { error: "Projection run storage is not configured" }
          }

          const parsed = ProjectionRunsQuerySchema.parse(query)
          const result = await storage.list({
            projectId: sixb.id,
            projectionId: parsed.projectionId,
            projectionKind: parsed.projectionKind,
            datasetId: parsed.datasetId,
            datasetVersionId: parsed.datasetVersionId,
            objectTypeIds: authz ? [...authz.grants["view:object"]] : undefined,
            statuses: parsed.status ? [parsed.status] : undefined,
            startedAfter: parseDate(parsed.startedAfter),
            startedBefore: parseDate(parsed.startedBefore),
            limit: parseOptionalInt(parsed.limit),
            offset: parseOptionalInt(parsed.offset),
            order: parsed.order,
          })

          return {
            runs: result.runs.map(serializeProjectionRun),
            hasMore: result.hasMore,
            total: result.total,
          }
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        query: ProjectionRunsQuerySchema,
        response: { 200: ProjectionRunListResponseSchema, 400: ErrorResponseSchema },
        detail: {
          summary: "List projection run history",
          tags: ["Projections"],
          operationId: "listProjectionRuns",
        },
      }
    )
    .get(
      "/api/projection-runs/:runId",
      async (context) => {
        const { params, set } = context
        const { authz } = requestAuthState(context)
        try {
          const storage = sixb.storage.projectionRuns
          if (!storage) {
            set.status = 400
            return { error: "Projection run storage is not configured" }
          }

          const run = await storage.getById({ projectId: sixb.id, id: params.runId })
          if (!run || !canViewProjectionRun(authz, run)) {
            set.status = 404
            return { error: "Projection run not found" }
          }

          return serializeProjectionRun(run)
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        params: ProjectionRunParamsSchema,
        response: {
          200: ProjectionRunSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
        detail: {
          summary: "Get a projection run by id",
          tags: ["Projections"],
          operationId: "getProjectionRun",
        },
      }
    )
}
