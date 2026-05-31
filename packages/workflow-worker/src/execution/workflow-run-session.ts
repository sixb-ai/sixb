import type {
  ValueType,
  WorkflowDefinition,
  WorkflowInterventionNodeDefinition,
  WorkflowInterventionRecord,
  WorkflowInterventionStorage,
  WorkflowIOSnapshot,
  WorkflowNodeDefinition,
  WorkflowNodeRunRecord,
  WorkflowRunRecord,
  WorkflowRunStorage,
} from "@pario/core"
import {
  snapshotWorkflowInput,
  snapshotWorkflowInterventionResponse,
  validateWorkflowInput,
  validateWorkflowInterventionResponse,
  validateWorkflowStepOutput,
} from "@pario/core"
import { WorkflowWorkerError } from "../errors"
import { statusForFailure, throwIfAborted, toWorkflowRunError } from "../normalize"
import { noopWorkflowRunObserver, WorkflowRunRecorder } from "../recorder"
import type {
  RunWorkflowJobInput,
  RunWorkflowResumeJobInput,
  WorkflowJob,
  WorkflowRunResult,
} from "../types"
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

  static async createForResume(
    input: RunWorkflowResumeJobInput,
    options: { readonly executors: WorkflowNodeExecutorRegistry }
  ): Promise<WorkflowRunSession | WorkflowRunResult> {
    const { runtime, job } = input
    const signal = input.signal ?? new AbortController().signal
    const workflow = requireWorkflow(runtime.getWorkflowById(job.workflowId), job)
    const valueTypesById = runtime.ontology.getValueTypesById()
    const workflowInterventions = runtime.storage.workflowInterventions

    if (!workflowInterventions) {
      throw new WorkflowWorkerError(
        `[ParioWorkflowWorker] Workflow '${job.workflowId}' resume requires storage.workflowInterventions.`
      )
    }

    throwIfAborted(signal)

    const intervention = await requireInterventionRecord({
      storage: workflowInterventions,
      projectId: runtime.projectId,
      id: job.pendingInterventionId,
    })
    const run = await requireWorkflowRun({
      workflowRuns: runtime.workflowRuns,
      projectId: runtime.projectId,
      id: job.id,
    })
    const waitingNode = await requireWorkflowNodeRun({
      workflowRuns: runtime.workflowRuns,
      projectId: runtime.projectId,
      id: intervention.nodeRunId,
    })

    assertResumeMatchesRun({ workflow, job, run, intervention, waitingNode })

    const nodeRuns = await runtime.workflowRuns.nodes.list({
      projectId: runtime.projectId,
      workflowRunId: job.id,
      order: "asc",
    })

    if (run.status === "succeeded" && waitingNode.status === "succeeded") {
      return {
        id: job.id,
        workflowId: workflow.id,
        status: "succeeded",
        run,
        nodes: nodeRuns.nodes,
        steps: reconstructWorkflowState({
          workflow,
          run,
          nodeRuns: nodeRuns.nodes,
          upToNodeIndex: workflow.nodes.length,
          valueTypesById,
        }).steps,
      }
    }

    if (run.status !== "waiting") {
      throw new WorkflowWorkerError(
        `[ParioWorkflowWorker] Workflow run '${job.id}' must be waiting to resume.`
      )
    }

    if (waitingNode.status !== "waiting") {
      throw new WorkflowWorkerError(
        `[ParioWorkflowWorker] Workflow node run '${waitingNode.id}' must be waiting to resume.`
      )
    }

    if (intervention.status !== "submitted" || !intervention.response) {
      throw new WorkflowWorkerError(
        `[ParioWorkflowWorker] Workflow intervention '${intervention.id}' must be submitted to resume.`
      )
    }

    const interventionNode = requireInterventionNode(workflow, intervention)
    const response = validateWorkflowInterventionResponse({
      workflowId: workflow.id,
      intervention: interventionNode.intervention,
      value: intervention.response,
      valueTypesById,
    })
    const responseSnapshot = snapshotWorkflowInterventionResponse({
      workflowId: workflow.id,
      intervention: interventionNode.intervention,
      value: response,
      valueTypesById,
    })
    const responseOutput: Record<string, unknown> = { ...response }
    const state = reconstructWorkflowState({
      workflow,
      run,
      nodeRuns: nodeRuns.nodes,
      upToNodeIndex: intervention.nodeIndex,
      valueTypesById,
    })
    const recorder = new WorkflowRunRecorder({
      projectId: runtime.projectId,
      workflow,
      runId: job.id,
      workflowRuns: runtime.workflowRuns,
      observer: input.observer ?? noopWorkflowRunObserver,
      initialCompletedNodes: nodeRuns.nodes.filter(
        (nodeRun) => nodeRun.nodeIndex < intervention.nodeIndex && nodeRun.status === "succeeded"
      ),
      alreadyStarted: true,
    })
    const session = new WorkflowRunSession({
      runtime,
      job,
      workflow,
      signal,
      valueTypesById,
      workflowInputSnapshot: run.input,
      state,
      recorder,
      runner: new WorkflowNodeRunner({
        recorder,
        executors: options.executors,
      }),
    })

    await runtime.workflowRuns.resume({
      projectId: runtime.projectId,
      id: job.id,
    })

    session.markSideEffectBoundaryPassed()

    try {
      await recorder.finishNodeSucceeded({
        nodeRunId: waitingNode.id,
        output: responseSnapshot,
      })
    } catch (error) {
      await session.finishAfterError(error)
      throw error
    }

    state.current = responseOutput
    state.steps[interventionNode.key] = responseOutput
    session.resumeFromIndex = intervention.nodeIndex + 1

    return session
  }

  private resumeFromIndex = 0

  async start(): Promise<void> {
    await this.dependencies.recorder.startRun({
      input: this.dependencies.workflowInputSnapshot,
    })
  }

  async runAllNodes(): Promise<WorkflowRunRecord | null> {
    return this.runNodesFrom(this.resumeFromIndex)
  }

  async runNodesFrom(startIndex: number): Promise<WorkflowRunRecord | null> {
    for (
      let nodeIndex = startIndex;
      nodeIndex < this.dependencies.workflow.nodes.length;
      nodeIndex++
    ) {
      const node = this.dependencies.workflow.nodes[nodeIndex]
      if (!node) {
        continue
      }

      throwIfAborted(this.dependencies.signal)

      const result = await this.dependencies.runner.runNode({
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

      if (result.status === "waiting") {
        return result.run
      }
    }

    return null
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

  finishWaiting(run: WorkflowRunRecord): WorkflowRunResult {
    return {
      id: this.dependencies.job.id,
      workflowId: this.dependencies.workflow.id,
      status: "waiting",
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
  job: { readonly workflowId: string }
): WorkflowDefinition {
  if (!workflow) {
    throw new WorkflowWorkerError(`[ParioWorkflowWorker] Unknown workflow '${job.workflowId}'.`)
  }

  return workflow
}

async function requireInterventionRecord(input: {
  readonly storage: WorkflowInterventionStorage
  readonly projectId: string
  readonly id: string
}): Promise<WorkflowInterventionRecord> {
  const intervention = await input.storage.getById({
    projectId: input.projectId,
    id: input.id,
  })

  if (!intervention) {
    throw new WorkflowWorkerError(
      `[ParioWorkflowWorker] Workflow intervention '${input.id}' not found.`
    )
  }

  return intervention
}

async function requireWorkflowRun(input: {
  readonly workflowRuns: WorkflowRunStorage
  readonly projectId: string
  readonly id: string
}): Promise<WorkflowRunRecord> {
  const run = await input.workflowRuns.getById({
    projectId: input.projectId,
    id: input.id,
  })

  if (!run) {
    throw new WorkflowWorkerError(`[ParioWorkflowWorker] Workflow run '${input.id}' not found.`)
  }

  return run
}

async function requireWorkflowNodeRun(input: {
  readonly workflowRuns: WorkflowRunStorage
  readonly projectId: string
  readonly id: string
}): Promise<WorkflowNodeRunRecord> {
  const node = await input.workflowRuns.nodes.getById({
    projectId: input.projectId,
    id: input.id,
  })

  if (!node) {
    throw new WorkflowWorkerError(
      `[ParioWorkflowWorker] Workflow node run '${input.id}' not found.`
    )
  }

  return node
}

function assertResumeMatchesRun(input: {
  readonly workflow: WorkflowDefinition
  readonly job: { readonly id: string; readonly workflowId: string }
  readonly run: WorkflowRunRecord
  readonly intervention: WorkflowInterventionRecord
  readonly waitingNode: WorkflowNodeRunRecord
}): void {
  if (input.run.workflowId !== input.workflow.id || input.job.workflowId !== input.workflow.id) {
    throw new WorkflowWorkerError(
      `[ParioWorkflowWorker] Workflow resume job for '${input.job.workflowId}' does not match run '${input.run.workflowId}'.`
    )
  }

  if (
    input.intervention.workflowId !== input.workflow.id ||
    input.intervention.workflowRunId !== input.job.id
  ) {
    throw new WorkflowWorkerError(
      `[ParioWorkflowWorker] Workflow intervention '${input.intervention.id}' does not match run '${input.job.id}'.`
    )
  }

  if (
    input.waitingNode.workflowId !== input.workflow.id ||
    input.waitingNode.workflowRunId !== input.job.id ||
    input.waitingNode.id !== input.intervention.nodeRunId
  ) {
    throw new WorkflowWorkerError(
      `[ParioWorkflowWorker] Workflow node run '${input.waitingNode.id}' does not match intervention '${input.intervention.id}'.`
    )
  }
}

function requireInterventionNode(
  workflow: WorkflowDefinition,
  intervention: WorkflowInterventionRecord
): WorkflowInterventionNodeDefinition {
  const node = workflow.nodes[intervention.nodeIndex]

  if (
    !node ||
    node.type !== "intervention" ||
    node.id !== intervention.nodeId ||
    node.key !== intervention.nodeKey
  ) {
    throw new WorkflowWorkerError(
      `[ParioWorkflowWorker] Workflow '${workflow.id}' does not contain intervention node '${intervention.nodeId}' at index ${intervention.nodeIndex}.`
    )
  }

  return node
}

function reconstructWorkflowState(input: {
  readonly workflow: WorkflowDefinition
  readonly run: WorkflowRunRecord
  readonly nodeRuns: readonly WorkflowNodeRunRecord[]
  readonly upToNodeIndex: number
  readonly valueTypesById: ReadonlyMap<string, ValueType>
}): WorkflowExecutionState {
  const workflowInput = validateWorkflowInput({
    workflow: input.workflow,
    value: input.run.input,
    valueTypesById: input.valueTypesById,
  })
  const state: WorkflowExecutionState = {
    workflowInput,
    current: workflowInput,
    steps: {},
  }
  const nodeRunsByIndex = new Map(input.nodeRuns.map((nodeRun) => [nodeRun.nodeIndex, nodeRun]))

  for (let nodeIndex = 0; nodeIndex < input.upToNodeIndex; nodeIndex++) {
    const node = input.workflow.nodes[nodeIndex]
    const nodeRun = nodeRunsByIndex.get(nodeIndex)
    if (!node || !nodeRun) {
      throw new WorkflowWorkerError(
        `[ParioWorkflowWorker] Workflow run '${input.run.id}' is missing node run at index ${nodeIndex}.`
      )
    }

    applyCompletedNodeToState({
      workflowId: input.workflow.id,
      node,
      nodeRun,
      state,
      valueTypesById: input.valueTypesById,
    })
  }

  return state
}

function applyCompletedNodeToState(input: {
  readonly workflowId: string
  readonly node: WorkflowNodeDefinition
  readonly nodeRun: WorkflowNodeRunRecord
  readonly state: WorkflowExecutionState
  readonly valueTypesById: ReadonlyMap<string, ValueType>
}): void {
  if (input.nodeRun.status !== "succeeded") {
    throw new WorkflowWorkerError(
      `[ParioWorkflowWorker] Workflow node run '${input.nodeRun.id}' must be succeeded to reconstruct workflow state.`
    )
  }

  if (input.node.type === "action") {
    return
  }

  const output = input.nodeRun.output ?? {}
  const validatedOutput =
    input.node.type === "step"
      ? validateWorkflowStepOutput({
          workflowId: input.workflowId,
          step: input.node.step,
          value: output,
          valueTypesById: input.valueTypesById,
        })
      : validateWorkflowInterventionResponse({
          workflowId: input.workflowId,
          intervention: input.node.intervention,
          value: output,
          valueTypesById: input.valueTypesById,
        })
  const stateOutput: Record<string, unknown> = { ...validatedOutput }

  input.state.current = stateOutput
  input.state.steps[input.node.key] = stateOutput
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
