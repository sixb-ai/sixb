import { canViewWorkflowIntervention, canViewWorkflowRun, isAllowed } from "../authorization"
import type { AuthorizablePrincipal, ExecutionContext } from "../execution"
import { resolveExecutionCosts } from "../runtime/ai-cost"
import { resolveExecutionUsage } from "../runtime/ai-usage"
import type { SixbRuntimeContext } from "../runtime/types"
import type { AiCostSummary } from "../storage/ai-cost"
import type { AiModelCallUsage } from "../storage/ai-usage"
import type {
  ListWorkflowInterventionsInput,
  ListWorkflowInterventionsResult,
  WorkflowInterventionRecord,
} from "../storage/workflow-interventions"
import type {
  ListLatestWorkflowRunsResult,
  ListWorkflowNodeRunsInput,
  ListWorkflowNodeRunsResult,
  ListWorkflowRunsInput,
  ListWorkflowRunsResult,
  WorkflowAgentNodeRunRecord,
  WorkflowNodeRunRecord,
  WorkflowRunRecord,
  WorkflowRunStorage,
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
  listNodes(
    runId: string,
    input?: ListWorkflowRunNodesInput
  ): Promise<WorkflowNodeRunListResult | null>
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

export type ListWorkflowRunNodesInput = Omit<
  ListWorkflowNodeRunsInput,
  "projectId" | "workflowRunId" | "workflowId"
>

/** Execution-facing Agent node view derived from its run row and model-call ledger. */
export interface WorkflowAgentNodeRunView
  extends Omit<WorkflowAgentNodeRunRecord, "execution" | "actorId"> {
  readonly usage?: AiModelCallUsage
  /** Preferred valuation; omitted when there are no calls or cost storage is unavailable. */
  readonly cost?: AiCostSummary
}

/** Execution-facing workflow node view with optional Agent execution details. */
export interface WorkflowNodeRunView extends WorkflowNodeRunRecord {
  readonly agentExecution?: WorkflowAgentNodeRunView
}

export interface WorkflowNodeRunListResult extends Omit<ListWorkflowNodeRunsResult, "nodes"> {
  readonly nodes: readonly WorkflowNodeRunView[]
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
  const getVisibleRunRecord = async (runId: string): Promise<WorkflowRunRecord | null> => {
    const run =
      (await runtime.storage.workflowRuns?.getById({
        projectId: runtime.projectId,
        id: runId,
      })) ?? null
    return run && canViewWorkflowRun(runtime.authorization, run) && canAccessHistory(run.workflowId)
      ? run
      : null
  }
  const getRun = async (runId: string): Promise<WorkflowRunView | null> => {
    const run = await getVisibleRunRecord(runId)
    return run ? attachRequestedBy(runtime, run) : null
  }
  const listNodes = async (
    runId: string,
    input: ListWorkflowRunNodesInput = {}
  ): Promise<WorkflowNodeRunListResult | null> => {
    const storage = runtime.storage.workflowRuns
    if (!storage || !(await getVisibleRunRecord(runId))) return null
    const result = await storage.nodes.list({
      projectId: runtime.projectId,
      ...input,
      workflowRunId: runId,
    })
    return {
      ...result,
      nodes: await attachWorkflowNodeViews(runtime, storage, result.nodes),
    }
  }

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
      getById: getRun,
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
      listNodes,
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

async function attachWorkflowNodeViews(
  runtime: SixbRuntimeContext,
  storage: WorkflowRunStorage,
  nodes: readonly WorkflowNodeRunRecord[]
): Promise<readonly WorkflowNodeRunView[]> {
  const executions = await Promise.all(
    nodes.map((node) =>
      node.nodeType === "agent"
        ? storage.agentNodes.getByNodeRunId({
            projectId: runtime.projectId,
            nodeRunId: node.id,
          })
        : null
    )
  )
  const agentExecutions = executions.filter(
    (execution): execution is WorkflowAgentNodeRunRecord => execution !== null
  )
  if (agentExecutions.length === 0) return nodes

  const executionIds = agentExecutions.map((execution) => execution.executionId)
  const [usages, costs] = await Promise.all([
    resolveExecutionUsage({
      storage: runtime.storage.aiUsage,
      projectId: runtime.projectId,
      executionIds,
    }),
    resolveExecutionCosts({
      storage: runtime.storage.aiCosts,
      projectId: runtime.projectId,
      executionIds,
    }),
  ])
  const accountingByExecutionId = new Map(
    agentExecutions.map((execution, index) => [
      execution.executionId,
      { usage: usages[index], cost: costs[index] },
    ])
  )

  return nodes.map((node, index) => {
    const execution = executions[index]
    if (!execution) return node
    const accounting = accountingByExecutionId.get(execution.executionId)
    return {
      ...node,
      agentExecution: toWorkflowAgentNodeRunView(
        execution,
        accounting?.usage,
        accounting?.usage === undefined ? undefined : accounting.cost
      ),
    }
  })
}

function toWorkflowAgentNodeRunView(
  execution: WorkflowAgentNodeRunRecord,
  usage: AiModelCallUsage | undefined,
  cost: AiCostSummary | undefined
): WorkflowAgentNodeRunView {
  return {
    projectId: execution.projectId,
    nodeRunId: execution.nodeRunId,
    executionId: execution.executionId,
    status: execution.status,
    prompt: execution.prompt,
    modelId: execution.modelId,
    finishReason: execution.finishReason,
    trace: execution.trace,
    diagnostics: execution.diagnostics,
    error: execution.error,
    attempt: execution.attempt,
    createdAt: execution.createdAt,
    startedAt: execution.startedAt,
    completedAt: execution.completedAt,
    ...(usage === undefined ? {} : { usage }),
    ...(usage === undefined || cost === undefined ? {} : { cost }),
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
