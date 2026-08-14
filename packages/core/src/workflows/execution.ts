import { canViewWorkflowIntervention, canViewWorkflowRun, isAllowed } from "../authorization"
import type { AuthorizablePrincipal, ExecutionContext } from "../execution"
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
  type WorkflowRunRequestOptions,
  type WorkflowRunRequestResult,
} from "./request"
import type { WorkflowDefinition } from "./types"

export interface WorkflowRunsRuntime {
  getById(runId: string): Promise<WorkflowRunView | null>
  list(
    input?: Omit<ListWorkflowRunsInput, "projectId" | "workflowIds">
  ): Promise<WorkflowRunListResult>
  listLatest(workflowIds: readonly string[]): Promise<LatestWorkflowRunListResult>
}

/** Execution-facing run view with provenance resolved from the immutable execution ledger. */
export interface WorkflowRunView extends WorkflowRunRecord {
  readonly requestedBy?: AuthorizablePrincipal
}

export interface WorkflowRunListResult extends Omit<ListWorkflowRunsResult, "runs"> {
  readonly runs: readonly WorkflowRunView[]
}

export interface LatestWorkflowRunListResult extends Omit<ListLatestWorkflowRunsResult, "runs"> {
  readonly runs: readonly WorkflowRunView[]
}

export interface WorkflowInterventionsRuntime {
  getById(interventionId: string): Promise<WorkflowInterventionRecord | null>
  list(
    input?: Omit<ListWorkflowInterventionsInput, "projectId" | "workflowIds">
  ): Promise<ListWorkflowInterventionsResult>
}

export interface WorkflowsRuntime {
  list(): readonly WorkflowDefinition[]
  getById(workflowId: string): WorkflowDefinition | null
  request(
    workflow: WorkflowDefinition,
    options?: WorkflowRunRequestOptions
  ): Promise<WorkflowRunRequestResult>
  requestById(input: RequestWorkflowRunInput): Promise<WorkflowRunRequestResult>
  readonly runs: WorkflowRunsRuntime
  readonly interventions: WorkflowInterventionsRuntime
}

export function createWorkflowsRuntime(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  source: Pick<WorkflowsRuntime, "list" | "getById">
): WorkflowsRuntime {
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
    request: (workflow, options) => requestWorkflowRun(runtime, execution, workflow, options),
    requestById: async (input) => {
      const workflow = source.getById(input.workflowId)
      if (!workflow) {
        throw new WorkflowValidationError(`[Sixb] Unknown workflow '${input.workflowId}'`)
      }
      return requestWorkflowRun(runtime, execution, workflow, input)
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
          ? attachRequestedBy(runtime, run)
          : null
      },
      list: async (input = {}) => {
        const storage = runtime.storage.workflowRuns
        if (!storage) return { runs: [], hasMore: false, total: 0 }
        const result = await storage.list({
          projectId: runtime.projectId,
          ...input,
          workflowIds: runtime.authorization ? visibleIds() : undefined,
        })
        return {
          ...result,
          runs: await Promise.all(result.runs.map((run) => attachRequestedBy(runtime, run))),
        }
      },
      listLatest: async (workflowIds) => {
        const storage = runtime.storage.workflowRuns
        if (!storage || workflowIds.length === 0) return { runs: [] }
        const allowedIds = workflowIds.filter(canAccessHistory)
        if (allowedIds.length === 0) return { runs: [] }
        const result = await storage.listLatestByWorkflowIds({
          projectId: runtime.projectId,
          workflowIds: allowedIds,
        })
        return {
          runs: await Promise.all(result.runs.map((run) => attachRequestedBy(runtime, run))),
        }
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

async function attachRequestedBy(
  runtime: SixbRuntimeContext,
  run: WorkflowRunRecord
): Promise<WorkflowRunView> {
  const execution = await runtime.storage.executions.getById({
    projectId: runtime.projectId,
    id: run.executionId,
  })
  if (!execution) {
    throw new Error(
      `[Sixb] Workflow run '${run.id}' references missing execution '${run.executionId}'.`
    )
  }
  return {
    ...run,
    ...(execution.requestedBy === undefined
      ? {}
      : { requestedBy: structuredClone(execution.requestedBy) }),
  }
}
