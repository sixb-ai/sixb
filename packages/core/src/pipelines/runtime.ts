import type { PipelineDefinition } from "./types"

export interface PipelinesRuntime {
  list(): readonly PipelineDefinition[]
  getById(pipelineId: string): PipelineDefinition | null
}

export function createPipelinesRuntime(
  definitions: readonly PipelineDefinition[]
): PipelinesRuntime {
  const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]))
  return {
    list: () => [...definitionsById.values()],
    getById: (pipelineId) => definitionsById.get(pipelineId) ?? null,
  }
}
