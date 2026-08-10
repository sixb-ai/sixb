import type { SixbRuntimeContext } from "../runtime/types"
import { PipelineError } from "./errors"
import {
  type PipelineRunRequestResult,
  type RequestPipelineRunInput,
  requestPipelineRun,
} from "./request"
import type { PipelineDefinition } from "./types"

export interface PipelinesRuntime {
  list(): readonly PipelineDefinition[]
  getById(pipelineId: string): PipelineDefinition | null
  request(input: RequestPipelineRunInput): Promise<PipelineRunRequestResult>
}

export function createPipelinesRuntime(
  runtime: SixbRuntimeContext,
  definitions: readonly PipelineDefinition[]
): PipelinesRuntime {
  const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]))
  return {
    list: () => [...definitionsById.values()],
    getById: (pipelineId) => definitionsById.get(pipelineId) ?? null,
    request: async (input) => {
      const pipeline = definitionsById.get(input.pipelineId)
      if (!pipeline) throw new PipelineError(`[Sixb] Unknown pipeline '${input.pipelineId}'`)
      return requestPipelineRun(runtime, pipeline, input)
    },
  }
}
