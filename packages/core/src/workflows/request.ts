import { assertAuthorized } from "../authorization"
import { resolveExecutionScopeAuthorization } from "../execution/authorization"
import {
  createPrimitiveExecutionRecord,
  ensureExecutionRecord,
  executionRecordInputFromRuntime,
} from "../execution/durable"
import type { ExecutionContext } from "../execution/types"
import { assertValidFileRefs } from "../ontology/validation"
import type { SixbRuntimeContext } from "../runtime/types"
import { dispatchWorkflowRun } from "./run-dispatch"
import { snapshotWorkflowInput } from "./snapshot"
import type { WorkflowDefinition, WorkflowIOSnapshot, WorkflowRunSource } from "./types"

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
  admitWorkflowRequest(runtime, execution, workflow, options.input)
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

/** A workflow start as it would run: authorized, with its input as the run would snapshot it. */
export interface PreparedWorkflowRequest {
  readonly workflowId: string
  readonly input: WorkflowIOSnapshot
}

/**
 * Admit a workflow start without starting it: the checks `requestWorkflowRun` applies, and the
 * input snapshot the run would store. The agent API gateway prepares the starts it holds for
 * approval.
 */
export function prepareWorkflowRequest(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  workflow: WorkflowDefinition,
  input: Readonly<Record<string, unknown>> = {}
): PreparedWorkflowRequest {
  admitWorkflowRequest(runtime, execution, workflow, input)
  return {
    workflowId: workflow.id,
    input: snapshotWorkflowInput({
      workflow,
      value: input,
      valueTypesById: runtime.ontology.getValueTypesById(),
    }),
  }
}

function admitWorkflowRequest(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  workflow: WorkflowDefinition,
  input: Readonly<Record<string, unknown>> | undefined
): void {
  resolveExecutionScopeAuthorization(runtime.projectId, {
    execution,
    authorization: runtime.runtimeAuthorization,
  })
  assertAuthorized(runtime, { kind: "workflow.run", workflowId: workflow.id })
  // Only caller input: automatic runs carry stored data, which may predate the rule.
  assertValidFileRefs(input, `Workflow "${workflow.id}" input`)
}
