import type {
  LinkProjectionDefinition,
  ObjectProjectionDefinition,
  OntologySource,
  ProjectionDefinition,
  Sixb,
  TelemetryProjectionDefinition,
} from "@sixb/core"
import { canViewProjection, canViewProjectionRun } from "@sixb/core/internal/authorization"
import type { ProjectionRunRecord } from "@sixb/core/storage"
import type { Elysia } from "elysia"
import { requestAuthState } from "../auth/scope"
import { OPENAPI_TAGS } from "../openapi/tags"
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
import {
  handleRouteError,
  parseDate,
  parseOptionalInt,
  toIsoString,
  unconfiguredStorageResponse,
} from "../utils/http"

function serializeProjectionRun(run: ProjectionRunRecord) {
  return ProjectionRunSchema.parse({
    id: run.id,
    projectId: run.projectId,
    identity: run.identity,
    target: run.target,
    status: run.status,
    attempt: run.attempt,
    progress: run.progress,
    startedAt: toIsoString(run.startedAt),
    finishedAt: run.finishedAt ? toIsoString(run.finishedAt) : undefined,
    error: run.error,
  })
}

type SerializedProjectionRun = ReturnType<typeof serializeProjectionRun>
type RequestAuthorization = ReturnType<typeof requestAuthState>["authz"]

interface ViewableProjectionCatalog {
  readonly objectProjections: readonly ObjectProjectionDefinition[]
  readonly linkProjections: readonly LinkProjectionDefinition[]
  readonly telemetryProjections: readonly TelemetryProjectionDefinition[]
}

async function getLatestProjectionRuns(
  sixb: Sixb<readonly OntologySource[]>,
  projectionIds: readonly string[]
): Promise<Map<string, SerializedProjectionRun>> {
  const storage = sixb.storage.projectionRuns
  if (!storage || projectionIds.length === 0) {
    return new Map()
  }

  const result = await storage.listLatestByProjectionIds({ projectId: sixb.id, projectionIds })
  return new Map(result.runs.map((run) => [run.identity.projectionId, serializeProjectionRun(run)]))
}

function listViewableProjections(
  sixb: Sixb<readonly OntologySource[]>,
  authz: RequestAuthorization
): ViewableProjectionCatalog {
  return {
    objectProjections: sixb
      .listObjectProjections()
      .filter((projection) => canViewProjection(authz, projection)),
    linkProjections: sixb
      .listLinkProjections()
      .filter((projection) => canViewProjection(authz, projection)),
    telemetryProjections: sixb
      .listTelemetryProjections()
      .filter((projection) => canViewProjection(authz, projection)),
  }
}

function projectionCatalogIds(catalog: ViewableProjectionCatalog): string[] {
  return [
    ...catalog.objectProjections,
    ...catalog.linkProjections,
    ...catalog.telemetryProjections,
  ].map((projection) => projection.id)
}

function serializeProjection<TProjection extends ProjectionDefinition>(
  projection: TProjection,
  latestRuns: ReadonlyMap<string, SerializedProjectionRun>
): TProjection & { latestRun: SerializedProjectionRun | null } {
  return {
    ...projection,
    latestRun: latestRuns.get(projection.id) ?? null,
  }
}

function serializeProjectionCatalog(
  catalog: ViewableProjectionCatalog,
  latestRuns: ReadonlyMap<string, SerializedProjectionRun>
) {
  return {
    objectProjections: catalog.objectProjections.map((projection) =>
      serializeProjection(projection, latestRuns)
    ),
    linkProjections: catalog.linkProjections.map((projection) =>
      serializeProjection(projection, latestRuns)
    ),
    telemetryProjections: catalog.telemetryProjections.map((projection) =>
      serializeProjection(projection, latestRuns)
    ),
  }
}

export function registerProjectionRoutes(app: Elysia, sixb: Sixb<readonly OntologySource[]>) {
  return app
    .get(
      "/api/projections",
      async (context) => {
        const { authz } = requestAuthState(context)
        const catalog = listViewableProjections(sixb, authz)
        const latestRuns = await getLatestProjectionRuns(sixb, projectionCatalogIds(catalog))
        return serializeProjectionCatalog(catalog, latestRuns)
      },
      {
        response: { 200: ProjectionListResponseSchema },
        detail: {
          summary: "List all projection definitions",
          tags: [OPENAPI_TAGS.projections.name],
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
        return serializeProjection(found, latestRuns)
      },
      {
        params: ProjectionParamsSchema,
        response: { 200: ProjectionResponseSchema, 404: ErrorResponseSchema },
        detail: {
          summary: "Get a projection definition by id",
          tags: [OPENAPI_TAGS.projections.name],
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
            return unconfiguredStorageResponse(set, "Projection run storage")
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
        response: {
          200: ProjectionRunListResponseSchema,
          400: ErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "List projection run history",
          tags: [OPENAPI_TAGS.projectionRuns.name],
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
            return unconfiguredStorageResponse(set, "Projection run storage")
          }

          const run = await storage.getById({ projectId: sixb.id, id: params.runId })
          if (!run || !canViewProjectionRun(authz, run.target)) {
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
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "Get a projection run by id",
          tags: [OPENAPI_TAGS.projectionRuns.name],
          operationId: "getProjectionRun",
        },
      }
    )
}
