import type { DatasetDefinition } from "./types"

export interface DatasetsRuntime {
  list(): readonly DatasetDefinition[]
  getById(datasetId: string): DatasetDefinition | null
}

export function createDatasetsRuntime(definitions: readonly DatasetDefinition[]): DatasetsRuntime {
  const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]))
  return {
    list: () => [...definitionsById.values()],
    getById: (datasetId) => definitionsById.get(datasetId) ?? null,
  }
}
