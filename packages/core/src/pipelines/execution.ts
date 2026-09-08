import { assertAuthorized, canViewPipelineRun, isRuntimeAllowed } from "../authorization"
import type { ExecutionContext } from "../execution"
import { resolveRuntimeAuthorizationForProject } from "../execution/authorization"
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
  execution: ExecutionContext,
  source: Pick<PipelinesRuntime, "list" | "getById">
): PipelinesRuntime {
  const authority = resolveRuntimeAuthorizationForProject(runtime)
  const allowed = (pipelineId: string) =>
    isRuntimeAllowed(runtime, { kind: "pipeline.run", pipelineId })
  const visibleIds = () =>
    source
      .list()
      .filter((pipeline) => allowed(pipeline.id))
      .map((pipeline) => pipeline.id)
  const historyFilterIds = () =>
    authority.type === "unrestricted"
      ? undefined
      : authority.type === "principal"
        ? visibleIds()
        : []

  const getRun = async (runId: string) => {
    if (authority.type === "denied" || authority.type === "delegated") return null
    const run =
      (await runtime.storage.pipelineRuns?.getById({
        projectId: runtime.projectId,
        id: runId,
      })) ?? null
    if (!run) return null
    return authority.type === "unrestricted" || canViewPipelineRun(authority.context, run)
      ? run
      : null
  }

  return {
    list: () =>
      authority.type === "denied" || authority.type === "delegated"
        ? []
        : source.list().filter((pipeline) => allowed(pipeline.id)),
    getById: (pipelineId) => {
      if (authority.type === "denied" || authority.type === "delegated") return null
      const pipeline = source.getById(pipelineId)
      return pipeline && allowed(pipelineId) ? pipeline : null
    },
    request: async (input) => {
      assertAuthorized(runtime, { kind: "pipeline.run", pipelineId: input.pipelineId })
      const pipeline = source.getById(input.pipelineId)
      if (!pipeline) throw new PipelineError(`[Sixb] Unknown pipeline '${input.pipelineId}'`)
      return requestPipelineRun(runtime, execution, pipeline, input)
    },
    runs: {
      getById: getRun,
      list: (input = {}) => {
        if (authority.type === "denied" || authority.type === "delegated") {
          return Promise.resolve({ runs: [], hasMore: false, total: 0 })
        }
        const storage = runtime.storage.pipelineRuns
        if (!storage) return Promise.resolve({ runs: [], hasMore: false, total: 0 })
        return storage.list({
          ...input,
          pipelineIds: historyFilterIds(),
          projectId: runtime.projectId,
        })
      },
      listLatest: (pipelineIds) => {
        if (authority.type === "denied" || authority.type === "delegated") {
          return Promise.resolve({ runs: [] })
        }
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
          ...input,
          pipelineRunId: runId,
          projectId: runtime.projectId,
        })
      },
    },
  }
}
