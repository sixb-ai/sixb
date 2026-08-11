import { canViewWorkflowIntervention, canViewWorkflowRun, isAllowed } from "../authorization"
import type { SixbRuntimeContext } from "../runtime/types"
import type {
  ListWorkflowInterventionsInput,
  ListWorkflowInterventionsResult,
  WorkflowInterventionRecord,
} from "../storage/workflow-interventions"
import type {
  ListLatestWorkflowRunsResult,
  ListWorkflowRunsInput,
  ListWorkflowRunsResult,
  WorkflowRunRecord,
} from "../storage/workflow-runs"
import { WorkflowValidationError } from "./errors"
import {
  type RequestWorkflowRunInput,
  requestWorkflowRun,
  type WorkflowRunRequestResult,
} from "./request"
import type { WorkflowDefinition } from "./types"

export interface ExecutionWorkflowRunsRuntime {
  getById(runId: string): Promise<WorkflowRunRecord | null>
  list(
    input?: Omit<ListWorkflowRunsInput, "projectId" | "workflowIds">
  ): Promise<ListWorkflowRunsResult>
  listLatest(workflowIds: readonly string[]): Promise<ListLatestWorkflowRunsResult>
}

export interface ExecutionWorkflowInterventionsRuntime {
  getById(interventionId: string): Promise<WorkflowInterventionRecord | null>
  list(
    input?: Omit<ListWorkflowInterventionsInput, "projectId" | "workflowIds">
  ): Promise<ListWorkflowInterventionsResult>
}

export interface ExecutionWorkflowsRuntime {
  list(): readonly WorkflowDefinition[]
  getById(workflowId: string): WorkflowDefinition | null
  requestById(input: RequestWorkflowRunInput): Promise<WorkflowRunRequestResult>
  readonly runs: ExecutionWorkflowRunsRuntime
  readonly interventions: ExecutionWorkflowInterventionsRuntime
}

export function createExecutionWorkflowsRuntime(
  runtime: SixbRuntimeContext,
  source: Pick<ExecutionWorkflowsRuntime, "list" | "getById">
): ExecutionWorkflowsRuntime {
  const allowed = (workflowId: string) =>
    isAllowed(runtime.authorization, { kind: "workflow.run", workflowId })
  const canAccessHistory = (workflowId: string) =>
    allowed(workflowId) && (!runtime.authorization || source.getById(workflowId) !== null)
  const visibleIds = () =>
    source
      .list()
      .filter((workflow) => allowed(workflow.id))
      .map((workflow) => workflow.id)

  return {
    list: () => source.list().filter((workflow) => allowed(workflow.id)),
    getById: (workflowId) => {
      const workflow = source.getById(workflowId)
      return workflow && allowed(workflowId) ? workflow : null
    },
    requestById: async (input) => {
      const workflow = source.getById(input.workflowId)
      if (!workflow) {
        throw new WorkflowValidationError(`[Sixb] Unknown workflow '${input.workflowId}'`)
      }
      return requestWorkflowRun(runtime, workflow, input)
    },
    runs: {
      getById: async (runId) => {
        const run =
          (await runtime.storage.workflowRuns?.getById({
            projectId: runtime.projectId,
            id: runId,
          })) ?? null
        return run &&
          canViewWorkflowRun(runtime.authorization, run) &&
          canAccessHistory(run.workflowId)
          ? run
          : null
      },
      list: (input = {}) => {
        const storage = runtime.storage.workflowRuns
        if (!storage) return Promise.resolve({ runs: [], hasMore: false, total: 0 })
        return storage.list({
          projectId: runtime.projectId,
          ...input,
          workflowIds: runtime.authorization ? visibleIds() : undefined,
        })
      },
      listLatest: (workflowIds) => {
        const storage = runtime.storage.workflowRuns
        if (!storage || workflowIds.length === 0) return Promise.resolve({ runs: [] })
        const allowedIds = workflowIds.filter(canAccessHistory)
        return allowedIds.length === 0
          ? Promise.resolve({ runs: [] })
          : storage.listLatestByWorkflowIds({
              projectId: runtime.projectId,
              workflowIds: allowedIds,
            })
      },
    },
    interventions: {
      getById: async (interventionId) => {
        const intervention =
          (await runtime.storage.workflowInterventions?.getById({
            projectId: runtime.projectId,
            id: interventionId,
          })) ?? null
        return intervention &&
          canViewWorkflowIntervention(runtime.authorization, intervention) &&
          canAccessHistory(intervention.workflowId)
          ? intervention
          : null
      },
      list: (input = {}) => {
        const storage = runtime.storage.workflowInterventions
        if (!storage) return Promise.resolve({ interventions: [], hasMore: false, total: 0 })
        return storage.list({
          projectId: runtime.projectId,
          ...input,
          workflowIds: runtime.authorization ? visibleIds() : undefined,
        })
      },
    },
  }
}
