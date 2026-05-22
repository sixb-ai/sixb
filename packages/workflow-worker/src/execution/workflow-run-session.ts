import type {
  ValueType,
  WorkflowDefinition,
  WorkflowIOSnapshot,
  WorkflowRunRecord,
} from "@pario/core"
import { snapshotWorkflowInput, validateWorkflowInput } from "@pario/core"
import { WorkflowWorkerError } from "../errors"
import { statusForFailure, throwIfAborted, toWorkflowRunError } from "../normalize"
import { noopWorkflowRunObserver, WorkflowRunRecorder } from "../recorder"
import type { RunWorkflowJobInput, WorkflowJob, WorkflowRunResult } from "../types"
import type { WorkflowExecutionState, WorkflowNodeExecutorRegistry } from "./node-executor"
import { WorkflowNodeRunner } from "./workflow-node-runner"

export class WorkflowRunSession {
  private sideEffectBoundaryPassed = false

  private constructor(
    private readonly dependencies: {
      readonly runtime: RunWorkflowJobInput["runtime"]
      readonly job: WorkflowJob
      readonly workflow: WorkflowDefinition
      readonly signal: AbortSignal
      readonly valueTypesById: ReadonlyMap<string, ValueType>
      readonly workflowInputSnapshot: WorkflowIOSnapshot
      readonly state: WorkflowExecutionState
      readonly recorder: WorkflowRunRecorder
      readonly runner: WorkflowNodeRunner
    }
  ) {}

  static create(
    input: RunWorkflowJobInput,
    options: { readonly executors: WorkflowNodeExecutorRegistry }
  ): WorkflowRunSession {
    const { runtime, job } = input
    const signal = input.signal ?? new AbortController().signal
    const workflow = requireWorkflow(runtime.getWorkflowById(job.workflowId), job)
    const valueTypesById = runtime.ontology.getValueTypesById()

    throwIfAborted(signal)

    const workflowInput = validateWorkflowInput({
      workflow,
      value: job.input ?? {},
      valueTypesById,
    })
    const workflowInputSnapshot = snapshotWorkflowInput({
      workflow,
      value: workflowInput,
      valueTypesById,
    })
    const state: WorkflowExecutionState = {
      workflowInput,
      current: workflowInput,
      steps: {},
    }
    const recorder = new WorkflowRunRecorder({
      projectId: runtime.projectId,
      workflow,
      runId: job.id,
      workflowRuns: runtime.workflowRuns,
      observer: input.observer ?? noopWorkflowRunObserver,
    })

    return new WorkflowRunSession({
      runtime,
      job,
      workflow,
      signal,
      valueTypesById,
      workflowInputSnapshot,
      state,
      recorder,
      runner: new WorkflowNodeRunner({
        recorder,
        executors: options.executors,
      }),
    })
  }

  async start(): Promise<void> {
    await this.dependencies.recorder.startRun({
      input: this.dependencies.workflowInputSnapshot,
    })
  }

  async runAllNodes(): Promise<void> {
    for (const [nodeIndex, node] of this.dependencies.workflow.nodes.entries()) {
      throwIfAborted(this.dependencies.signal)

      await this.dependencies.runner.runNode({
        node,
        nodeIndex,
        context: {
          runtime: this.dependencies.runtime,
          workflow: this.dependencies.workflow,
          job: this.dependencies.job,
          valueTypesById: this.dependencies.valueTypesById,
          signal: this.dependencies.signal,
          state: this.dependencies.state,
          markSideEffectBoundaryPassed: () => this.markSideEffectBoundaryPassed(),
        },
      })
    }
  }

  async finishSucceeded(): Promise<WorkflowRunResult> {
    const run = await this.finishWorkflowRun()

    return {
      id: this.dependencies.job.id,
      workflowId: this.dependencies.workflow.id,
      status: "succeeded",
      run,
      nodes: this.dependencies.recorder.completedNodes,
      steps: this.dependencies.state.steps,
    }
  }

  async finishAfterError(error: unknown): Promise<void> {
    const status = statusForFailure(this.dependencies.signal, error)
    if (!this.dependencies.recorder.hasStarted || this.dependencies.recorder.hasFinished) {
      return
    }

    await this.dependencies.recorder.finishActiveNodeAfterError({
      status,
      error: toWorkflowRunError(error),
    })

    await this.finishWorkflowRunAfterError({ error, status })
  }

  private markSideEffectBoundaryPassed(): void {
    this.sideEffectBoundaryPassed = true
  }

  private async finishWorkflowRun(): Promise<WorkflowRunRecord> {
    try {
      return await this.dependencies.recorder.finishRunSucceeded()
    } catch (error) {
      if (this.sideEffectBoundaryPassed) {
        throw createWorkflowBookkeepingError({
          workflowId: this.dependencies.workflow.id,
          runId: this.dependencies.job.id,
          cause: error,
        })
      }
      throw error
    }
  }

  private async finishWorkflowRunAfterError(input: {
    readonly error: unknown
    readonly status: "failed" | "cancelled"
  }): Promise<void> {
    const finishError = await this.dependencies.recorder
      .finishRunAfterError({
        status: input.status,
        error: toWorkflowRunError(input.error),
      })
      .then(() => null)
      .catch((error: unknown) => error)

    if (finishError && this.sideEffectBoundaryPassed) {
      throw createWorkflowBookkeepingError({
        workflowId: this.dependencies.workflow.id,
        runId: this.dependencies.job.id,
        cause: finishError,
      })
    }
  }
}

function requireWorkflow(
  workflow: WorkflowDefinition | null,
  job: WorkflowJob
): WorkflowDefinition {
  if (!workflow) {
    throw new WorkflowWorkerError(`[ParioWorkflowWorker] Unknown workflow '${job.workflowId}'.`)
  }

  return workflow
}

function createWorkflowBookkeepingError(input: {
  readonly workflowId: string
  readonly runId: string
  readonly cause: unknown
}): Error {
  return new WorkflowWorkerError(
    `[ParioWorkflowWorker] Workflow '${input.workflowId}' executed side effects, but failed to finalize workflow run '${input.runId}'. The workflow state may need repair.`,
    { cause: input.cause }
  )
}
