import { snapshotRequesterGroupIds } from "../auth/attribution"
import { assertAuthorized } from "../authorization"
import { resolveExecutionScopeAuthorization } from "../execution/authorization"
import {
  createPrimitiveExecutionRecord,
  ensureExecutionRecord,
  executionRecordInputFromRuntime,
} from "../execution/durable"
import type { ExecutionContext } from "../execution/types"
import type { SixbRuntimeContext } from "../runtime/types"
import { dispatchWorkflowRun } from "./run-dispatch"
import type { WorkflowDefinition, WorkflowRunSource } from "./types"

export interface WorkflowRunRequestOptions {
  readonly input?: Readonly<Record<string, unknown>>
  readonly runId?: string
  readonly source?: WorkflowRunSource
}

export interface RequestWorkflowRunInput extends WorkflowRunRequestOptions {
  readonly workflowId: string
}

export interface WorkflowRunRequestResult {
  readonly workflowId: string
  readonly runId: string
  readonly queuedAt: string
  readonly jobId?: string
  /**
   * `false` when a deterministic `runId` already existed for the same workflow,
   * so no second queue job was enqueued.
   */
  readonly created: boolean
}

/**
 * Validate, snapshot, persist, queue, and announce a workflow run request.
 *
 * Operates on an already-resolved workflow definition and the shared runtime
 * context, so it stays decoupled from how workflows are registered or looked up.
 */
export async function requestWorkflowRun(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  workflow: WorkflowDefinition,
  options: WorkflowRunRequestOptions = {}
): Promise<WorkflowRunRequestResult> {
  resolveExecutionScopeAuthorization(runtime.projectId, {
    execution,
    authorization: runtime.runtimeAuthorization,
  })
  assertAuthorized(runtime, { kind: "workflow.run", workflowId: workflow.id })
  const requesterGroupIds = execution.requestedBy
    ? await snapshotRequesterGroupIds({
        auth: runtime.storage.auth,
        projectId: runtime.projectId,
        principal: execution.requestedBy,
      })
    : []
  return dispatchWorkflowRun({
    errorReporterHost: runtime,
    projectId: runtime.projectId,
    workflow,
    valueTypesById: runtime.ontology.getValueTypesById(),
    storage: runtime.storage,
    queue: runtime.queues.workflows,
    events: runtime.events,
    runId: options.runId,
    input: options.input,
    source: options.source,
    requesterGroupIds,
    createExecution: async (executionId, runId) => {
      const caller = await ensureExecutionRecord(
        runtime.storage.executions,
        executionRecordInputFromRuntime({
          execution,
          runtimeAuthorization: runtime.runtimeAuthorization,
        })
      )
      return createPrimitiveExecutionRecord({
        id: executionId,
        primitive: { kind: "workflow", id: workflow.id, runId },
        origin: { type: "execution", parent: caller },
      })
    },
  })
}
