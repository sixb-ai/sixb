import { SixbError } from "../errors"
import type { SixbRuntimeContext } from "../runtime/types"
import {
  type RequestWorkflowRunInput,
  requestWorkflowRun,
  type WorkflowRunRequestResult,
} from "./request"
import type { InferWorkflowInput, WorkflowDefinition, WorkflowRunSource } from "./types"

/**
 * Typed entry point for workflow definitions and runs, exposed as
 * `sixb.workflows`.
 *
 * Owns the registered workflow definitions and implements lookup directly,
 * then delegates run requests to {@link requestWorkflowRun}.
 */
export class WorkflowsRuntime {
  private readonly runtime: SixbRuntimeContext
  private readonly workflowsById: ReadonlyMap<string, WorkflowDefinition>

  constructor(runtime: SixbRuntimeContext, workflows: readonly WorkflowDefinition[]) {
    this.runtime = runtime
    this.workflowsById = new Map(workflows.map((workflow) => [workflow.id, workflow]))
  }

  /** All registered workflow definitions. */
  list(): readonly WorkflowDefinition[] {
    return [...this.workflowsById.values()]
  }

  /** Look up a registered workflow definition by id. */
  getById(workflowId: string): WorkflowDefinition | null {
    return this.workflowsById.get(workflowId) ?? null
  }

  /** Start a run for a known workflow definition with typed input. */
  request<TWorkflow extends WorkflowDefinition>(
    workflow: TWorkflow,
    options: {
      readonly input?: InferWorkflowInput<TWorkflow>
      readonly runId?: string
      readonly source?: WorkflowRunSource
    } = {}
  ): Promise<WorkflowRunRequestResult> {
    return this.requestById({ workflowId: workflow.id, ...options })
  }

  /** Start a run by workflow id (server routes and dynamic use cases). */
  async requestById(input: RequestWorkflowRunInput): Promise<WorkflowRunRequestResult> {
    return this.requestByIdAs(this.runtime, input)
  }

  /**
   * Start a run by id on behalf of an explicit runtime context, so the scoped
   * SDK can enforce run grants while reusing the registered definitions.
   */
  async requestByIdAs(
    runtime: SixbRuntimeContext,
    input: RequestWorkflowRunInput
  ): Promise<WorkflowRunRequestResult> {
    const workflow = this.getById(input.workflowId)
    if (!workflow) {
      throw new SixbError("workflow.not_found", `[Sixb] Unknown workflow '${input.workflowId}'`)
    }

    return requestWorkflowRun(runtime, workflow, input)
  }
}
