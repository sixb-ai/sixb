import { isRuntimeAllowed } from "../authorization"
import { resolveRuntimeAuthorizationForProject } from "../execution/authorization"
import type { SixbRuntimeContext } from "../runtime/types"
import type { DatasetDefinition } from "./types"

export interface DatasetsRuntime {
  list(): readonly DatasetDefinition[]
  getById(datasetId: string): DatasetDefinition | null
}

export function createDatasetsRuntime(
  runtime: SixbRuntimeContext,
  source: Pick<DatasetsRuntime, "list" | "getById">
): DatasetsRuntime {
  const authority = resolveRuntimeAuthorizationForProject(runtime)
  const allowed = (datasetId: string) =>
    isRuntimeAllowed(runtime, { kind: "dataset.view", datasetId })

  return {
    list: () =>
      authority.type === "denied" || authority.type === "delegated"
        ? []
        : source.list().filter((dataset) => allowed(dataset.id)),
    getById: (datasetId) => {
      if (authority.type === "denied" || authority.type === "delegated") return null
      const dataset = source.getById(datasetId)
      return dataset && allowed(datasetId) ? dataset : null
    },
  }
}
