import { canViewProjection, canViewProjectionRun } from "../authorization"
import { resolveRuntimeAuthorizationForProject } from "../execution/authorization"
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
  const authority = resolveRuntimeAuthorizationForProject(runtime)
  const listVisible = <TProjection extends ProjectionDefinition>(
    list: () => readonly TProjection[]
  ): readonly TProjection[] => {
    switch (authority.type) {
      case "denied":
      case "delegated":
        return []
      case "principal":
        return list().filter((projection) => canViewProjection(authority.context, projection))
      case "unrestricted":
        return [...list()]
    }
  }
  const visible = (projection: ProjectionDefinition) => {
    switch (authority.type) {
      case "denied":
      case "delegated":
        return false
      case "principal":
        return canViewProjection(authority.context, projection)
      case "unrestricted":
        return true
    }
  }
  const visibleIds = (projectionIds: readonly string[]) =>
    projectionIds.filter((projectionId) => {
      const projection = source.getById(projectionId)
      return projection !== null && visible(projection)
    })

  return {
    list: () => listVisible(() => source.list()),
    listObjects: () => listVisible(() => source.listObjects()),
    listLinks: () => listVisible(() => source.listLinks()),
    listTelemetry: () => listVisible(() => source.listTelemetry()),
    getById: (projectionId) => {
      switch (authority.type) {
        case "denied":
        case "delegated":
          return null
        case "principal":
        case "unrestricted":
          break
      }
      const projection = source.getById(projectionId)
      return projection && visible(projection) ? projection : null
    },
    runs: {
      getById: async (runId) => {
        switch (authority.type) {
          case "denied":
          case "delegated":
            return null
          case "principal":
          case "unrestricted":
            break
        }
        const run =
          (await runtime.storage.projectionRuns?.getById({
            projectId: runtime.projectId,
            id: runId,
          })) ?? null
        if (!run) return null
        return authority.type === "unrestricted" ||
          canViewProjectionRun(authority.context, run.target)
          ? run
          : null
      },
      list: (input = {}) => {
        switch (authority.type) {
          case "denied":
          case "delegated":
            return Promise.resolve({ runs: [], hasMore: false, total: 0 })
          case "principal":
          case "unrestricted":
            break
        }
        const storage = runtime.storage.projectionRuns
        if (!storage) return Promise.resolve({ runs: [], hasMore: false, total: 0 })
        return storage.list({
          ...input,
          objectTypeIds:
            authority.type === "principal"
              ? [...authority.context.grants["view:object"]]
              : undefined,
          projectId: runtime.projectId,
        })
      },
      listLatest: (projectionIds) => {
        switch (authority.type) {
          case "denied":
          case "delegated":
            return Promise.resolve({ runs: [] })
          case "principal":
          case "unrestricted":
            break
        }
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
