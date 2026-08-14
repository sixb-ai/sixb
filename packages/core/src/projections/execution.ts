import { canViewProjection, canViewProjectionRun } from "../authorization"
import type { SixbRuntimeContext } from "../runtime/types"
import type {
  ListLatestProjectionRunsResult,
  ListProjectionRunsInput,
  ListProjectionRunsResult,
  ProjectionRunRecord,
} from "../storage/projection-runs"
import type { ProjectionDefinitionCatalog } from "./registry"
import type {
  LinkProjectionDefinition,
  ObjectProjectionDefinition,
  ProjectionDefinition,
  TelemetryProjectionDefinition,
} from "./types"

export interface ProjectionRunsRuntime {
  getById(runId: string): Promise<ProjectionRunRecord | null>
  list(
    input?: Omit<ListProjectionRunsInput, "projectId" | "objectTypeIds">
  ): Promise<ListProjectionRunsResult>
  listLatest(projectionIds: readonly string[]): Promise<ListLatestProjectionRunsResult>
}

export interface ProjectionsRuntime {
  list(): readonly ProjectionDefinition[]
  listObjects(): readonly ObjectProjectionDefinition[]
  listLinks(): readonly LinkProjectionDefinition[]
  listTelemetry(): readonly TelemetryProjectionDefinition[]
  getById(projectionId: string): ProjectionDefinition | null
  readonly runs: ProjectionRunsRuntime
}

export function createProjectionsRuntime(
  runtime: SixbRuntimeContext,
  source: ProjectionDefinitionCatalog
): ProjectionsRuntime {
  const visible = (projection: ProjectionDefinition) =>
    canViewProjection(runtime.authorization, projection)
  const visibleIds = (projectionIds: readonly string[]) =>
    projectionIds.filter((projectionId) => {
      const projection = source.getById(projectionId)
      return projection !== null && visible(projection)
    })

  return {
    list: () => source.list().filter(visible),
    listObjects: () => source.listObjects().filter(visible),
    listLinks: () => source.listLinks().filter(visible),
    listTelemetry: () => source.listTelemetry().filter(visible),
    getById: (projectionId) => {
      const projection = source.getById(projectionId)
      return projection && visible(projection) ? projection : null
    },
    runs: {
      getById: async (runId) => {
        const run =
          (await runtime.storage.projectionRuns?.getById({
            projectId: runtime.projectId,
            id: runId,
          })) ?? null
        return run && canViewProjectionRun(runtime.authorization, run.target) ? run : null
      },
      list: (input = {}) => {
        const storage = runtime.storage.projectionRuns
        if (!storage) return Promise.resolve({ runs: [], hasMore: false, total: 0 })
        return storage.list({
          projectId: runtime.projectId,
          ...input,
          objectTypeIds: runtime.authorization
            ? [...runtime.authorization.grants["view:object"]]
            : undefined,
        })
      },
      listLatest: (projectionIds) => {
        const storage = runtime.storage.projectionRuns
        if (!storage || projectionIds.length === 0) return Promise.resolve({ runs: [] })
        const ids = visibleIds(projectionIds)
        return ids.length === 0
          ? Promise.resolve({ runs: [] })
          : storage.listLatestByProjectionIds({ projectId: runtime.projectId, projectionIds: ids })
      },
    },
  }
}
