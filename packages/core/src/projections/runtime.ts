import type { ProjectionRegistry } from "./registry"
import type {
  LinkProjectionDefinition,
  ObjectProjectionDefinition,
  ProjectionDefinition,
  TelemetryProjectionDefinition,
} from "./types"

export interface ProjectionsRuntime {
  list(): readonly ProjectionDefinition[]
  listObjects(): readonly ObjectProjectionDefinition[]
  listLinks(): readonly LinkProjectionDefinition[]
  listTelemetry(): readonly TelemetryProjectionDefinition[]
  getById(projectionId: string): ProjectionDefinition | null
}

export function createProjectionsRuntime(registry: ProjectionRegistry): ProjectionsRuntime {
  return {
    list: () => [
      ...registry.listObjectProjections(),
      ...registry.listLinkProjections(),
      ...registry.listTelemetryProjections(),
    ],
    listObjects: () => registry.listObjectProjections(),
    listLinks: () => registry.listLinkProjections(),
    listTelemetry: () => registry.listTelemetryProjections(),
    getById: (projectionId) => registry.getProjectionById(projectionId),
  }
}
