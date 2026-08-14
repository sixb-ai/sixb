import { isAllowed } from "../authorization"
import type { SixbRuntimeContext } from "../runtime/types"
import type { DatasetDefinition } from "./types"

export interface DatasetsRuntime {
  list(): readonly DatasetDefinition[]
  getById(datasetId: string): DatasetDefinition | null
}

export function createDatasetsRuntime(
  runtime: Pick<SixbRuntimeContext, "authorization">,
  source: Pick<DatasetsRuntime, "list" | "getById">
): DatasetsRuntime {
  const allowed = (datasetId: string) =>
    isAllowed(runtime.authorization, { kind: "dataset.view", datasetId })

  return {
    list: () => source.list().filter((dataset) => allowed(dataset.id)),
    getById: (datasetId) => {
      const dataset = source.getById(datasetId)
      return dataset && allowed(datasetId) ? dataset : null
    },
  }
}
