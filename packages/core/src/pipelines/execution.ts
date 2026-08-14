import { canViewPipelineRun, isAllowed } from "../authorization"
import type { SixbRuntimeContext } from "../runtime/types"
import type {
  ListLatestPipelineRunsResult,
  ListPipelineRunsInput,
  ListPipelineRunsResult,
  ListPipelineStepRunsInput,
  ListPipelineStepRunsResult,
  PipelineRunRecord,
} from "../storage/pipeline-runs"
import { PipelineError } from "./errors"
import {
  type PipelineRunRequestResult,
  type RequestPipelineRunInput,
  requestPipelineRun,
} from "./request"
import type { PipelineDefinition } from "./types"

export interface PipelineRunsRuntime {
  getById(runId: string): Promise<PipelineRunRecord | null>
  list(
    input?: Omit<ListPipelineRunsInput, "projectId" | "pipelineIds">
  ): Promise<ListPipelineRunsResult>
  listLatest(pipelineIds: readonly string[]): Promise<ListLatestPipelineRunsResult>
  listSteps(
    runId: string,
    input?: Omit<ListPipelineStepRunsInput, "projectId" | "pipelineRunId">
  ): Promise<ListPipelineStepRunsResult | null>
}

export interface PipelinesRuntime {
  list(): readonly PipelineDefinition[]
  getById(pipelineId: string): PipelineDefinition | null
  request(input: RequestPipelineRunInput): Promise<PipelineRunRequestResult>
  readonly runs: PipelineRunsRuntime
}

export function createPipelinesRuntime(
  runtime: SixbRuntimeContext,
  source: Pick<PipelinesRuntime, "list" | "getById">
): PipelinesRuntime {
  const allowed = (pipelineId: string) =>
    isAllowed(runtime.authorization, { kind: "pipeline.run", pipelineId })
  const visibleIds = () =>
    source
      .list()
      .filter((pipeline) => allowed(pipeline.id))
      .map((pipeline) => pipeline.id)

  const getRun = async (runId: string) => {
    const run =
      (await runtime.storage.pipelineRuns?.getById({
        projectId: runtime.projectId,
        id: runId,
      })) ?? null
    return run && canViewPipelineRun(runtime.authorization, run) ? run : null
  }

  return {
    list: () => source.list().filter((pipeline) => allowed(pipeline.id)),
    getById: (pipelineId) => {
      const pipeline = source.getById(pipelineId)
      return pipeline && allowed(pipelineId) ? pipeline : null
    },
    request: async (input) => {
      const pipeline = source.getById(input.pipelineId)
      if (!pipeline) throw new PipelineError(`[Sixb] Unknown pipeline '${input.pipelineId}'`)
      return requestPipelineRun(runtime, pipeline, input)
    },
    runs: {
      getById: getRun,
      list: (input = {}) => {
        const storage = runtime.storage.pipelineRuns
        if (!storage) return Promise.resolve({ runs: [], hasMore: false, total: 0 })
        return storage.list({
          projectId: runtime.projectId,
          ...input,
          pipelineIds: runtime.authorization ? visibleIds() : undefined,
        })
      },
      listLatest: (pipelineIds) => {
        const storage = runtime.storage.pipelineRuns
        if (!storage || pipelineIds.length === 0) return Promise.resolve({ runs: [] })
        const allowedIds = pipelineIds.filter(allowed)
        return allowedIds.length === 0
          ? Promise.resolve({ runs: [] })
          : storage.listLatestByPipelineIds({
              projectId: runtime.projectId,
              pipelineIds: allowedIds,
            })
      },
      listSteps: async (runId, input = {}) => {
        const storage = runtime.storage.pipelineRuns
        if (!storage || !(await getRun(runId))) return null
        return storage.listSteps({
          projectId: runtime.projectId,
          ...input,
          pipelineRunId: runId,
        })
      },
    },
  }
}
