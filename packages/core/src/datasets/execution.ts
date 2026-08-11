import { isAllowed } from "../authorization"
import type { SixbRuntimeContext } from "../runtime/types"
import type { DatasetDefinition } from "./types"

export interface ExecutionDatasetsRuntime {
  list(): readonly DatasetDefinition[]
  getById(datasetId: string): DatasetDefinition | null
}

export function createExecutionDatasetsRuntime(
  runtime: Pick<SixbRuntimeContext, "authorization">,
  source: Pick<ExecutionDatasetsRuntime, "list" | "getById">
): ExecutionDatasetsRuntime {
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
