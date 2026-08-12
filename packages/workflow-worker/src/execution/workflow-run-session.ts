import type { ValueType, WorkflowDefinition } from "@sixb/core"
import { resolveLoggingService } from "@sixb/core/internal/logging"
import type {
  WorkflowAgentNodeDefinition,
  WorkflowInterventionNodeDefinition,
  WorkflowIOSnapshot,
  WorkflowNodeDefinition,
} from "@sixb/core/internal/workflows"
import {
  snapshotWorkflowInput,
  snapshotWorkflowInterventionResponse,
  validateWorkflowAgentStepOutput,
  validateWorkflowInput,
  validateWorkflowInterventionResponse,
  validateWorkflowStepOutput,
} from "@sixb/core/internal/workflows"
import type {
  WorkflowInterventionRecord,
  WorkflowInterventionStorage,
  WorkflowNodeRunRecord,
  WorkflowRunRecord,
  WorkflowRunStorage,
} from "@sixb/core/storage"
import { WorkflowWorkerError } from "../errors"
import { statusForFailure, throwIfAborted, toWorkflowRunError } from "../normalize"
import { noopWorkflowRunObserver, WorkflowRunRecorder } from "../recorder"
import type {
  RunWorkflowJobInput,
  RunWorkflowResumeJobInput,
  WorkflowJob,
  WorkflowLogSession,
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
      readonly logSession: WorkflowLogSession
      readonly valueTypesById: ReadonlyMap<string, ValueType>
      readonly workflowInputSnapshot: WorkflowIOSnapshot
      readonly state: WorkflowExecutionState
      readonly recorder: WorkflowRunRecorder
      readonly runner: WorkflowNodeRunner
      readonly onRunFailed?: RunWorkflowJobInput["onRunFailed"]
    }
  ) {}

  static create(
    input: RunWorkflowJobInput,
    options: { readonly executors: WorkflowNodeExecutorRegistry }
  ): WorkflowRunSession {
    const { runtime, job } = input
    const signal = input.signal ?? new AbortController().signal
    const workflow = requireWorkflow(runtime.sixb.workflows.getById(job.workflowId), job)
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
      currentSnapshot: workflowInputSnapshot,
      steps: {},
    }
    const recorder = new WorkflowRunRecorder({
      projectId: runtime.projectId,
      workflow,
      runId: job.id,
      workflowRuns: runtime.workflowRuns,
      observer: input.observer ?? noopWorkflowRunObserver,
      execution: job.execution,
    })
    const logSession = resolveLoggingService(runtime.projectId, runtime.logging).startExecution({
      kind: "workflow",
      id: job.id,
    })

    return new WorkflowRunSession({
      runtime,
      job,
      workflow,
      signal,
      logSession,
      valueTypesById,
      workflowInputSnapshot,
      state,
      recorder,
      runner: new WorkflowNodeRunner({
        recorder,
        executors: options.executors,
      }),
      onRunFailed: input.onRunFailed,
    })
  }

  /** Restore a persisted running execution after its previous queue delivery was lost. */
  static async recoverRunning(
    input: RunWorkflowJobInput | RunWorkflowResumeJobInput,
    options: { readonly executors: WorkflowNodeExecutorRegistry }
  ): Promise<WorkflowRunSession> {
    const { runtime, job } = input
    if (!job.execution) {
      throw new WorkflowWorkerError(
        `[SixbWorkflowWorker] Running workflow '${job.id}' can only be recovered by a queue-owned execution.`
      )
    }

    const signal = input.signal ?? new AbortController().signal
    const workflow = requireWorkflow(runtime.sixb.workflows.getById(job.workflowId), job)
    const valueTypesById = runtime.ontology.getValueTypesById()
    throwIfAborted(signal)

    const run = await requireWorkflowRun({
      workflowRuns: runtime.workflowRuns,
      projectId: runtime.projectId,
      id: job.id,
    })
    if (run.workflowId !== workflow.id || run.status !== "running") {
      throw new WorkflowWorkerError(
        `[SixbWorkflowWorker] Workflow run '${job.id}' is not a running '${workflow.id}' execution.`
      )
    }

    const listed = await runtime.workflowRuns.nodes.list({
      projectId: runtime.projectId,
      workflowRunId: run.id,
      order: "asc",
    })
    const recovery = analyzeRunningWorkflowHistory({ workflow, nodeRuns: listed.nodes })
    const state = reconstructWorkflowState({
      workflow,
      run,
      nodeRuns: recovery.completed,
      upToNodeIndex: recovery.resumeFromIndex,
      valueTypesById,
    })

    await runtime.workflowRuns.reclaim({
      projectId: runtime.projectId,
      id: run.id,
      execution: job.execution,
    })

    const recorder = new WorkflowRunRecorder({
      projectId: runtime.projectId,
      workflow,
      runId: run.id,
      workflowRuns: runtime.workflowRuns,
      observer: input.observer ?? noopWorkflowRunObserver,
      initialCompletedNodes: recovery.completed,
      initialRunningNode: recovery.running,
      alreadyStarted: true,
      execution: job.execution,
    })
    const logSession = resolveLoggingService(runtime.projectId, runtime.logging).startExecution({
      kind: "workflow",
      id: run.id,
    })
    const session = new WorkflowRunSession({
      runtime,
      job,
      workflow,
      signal,
      logSession,
      valueTypesById,
      workflowInputSnapshot: run.input,
      state,
      recorder,
      runner: new WorkflowNodeRunner({ recorder, executors: options.executors }),
      onRunFailed: input.onRunFailed,
    })
    session.resumeFromIndex = recovery.resumeFromIndex
    session.sideEffectBoundaryPassed = listed.nodes.length > 0
    return session
  }

  static async createForResume(
    input: RunWorkflowResumeJobInput,
    options: { readonly executors: WorkflowNodeExecutorRegistry }
  ): Promise<WorkflowRunSession | WorkflowRunResult> {
    const { runtime, job } = input
    const signal = input.signal ?? new AbortController().signal
    const workflow = requireWorkflow(runtime.sixb.workflows.getById(job.workflowId), job)
    const valueTypesById = runtime.ontology.getValueTypesById()
    if (job.resume.kind === "agentNode") {
      throwIfAborted(signal)
      const run = await requireWorkflowRun({
        workflowRuns: runtime.workflowRuns,
        projectId: runtime.projectId,
        id: job.id,
      })
      const completedNode = await requireWorkflowNodeRun({
        workflowRuns: runtime.workflowRuns,
        projectId: runtime.projectId,
        id: job.resume.nodeRunId,
      })
      const execution = await runtime.workflowRuns.agentNodes.getByNodeRunId({
        projectId: runtime.projectId,
        nodeRunId: completedNode.id,
      })
      if (
        completedNode.workflowRunId !== run.id ||
        completedNode.workflowId !== workflow.id ||
        completedNode.nodeType !== "agent" ||
        !execution ||
        execution.nodeRunId !== completedNode.id
      ) {
        throw new WorkflowWorkerError(
          `[SixbWorkflowWorker] Agent node '${completedNode.id}' does not belong to workflow run '${run.id}'.`
        )
      }
      if (run.status === "running") {
        return WorkflowRunSession.recoverRunning(input, options)
      }
      const nodeRuns = await runtime.workflowRuns.nodes.list({
        projectId: runtime.projectId,
        workflowRunId: job.id,
        order: "asc",
      })
      if (run.status === "succeeded") {
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
      if (run.status !== "waiting" || completedNode.status !== "succeeded") {
        throw new WorkflowWorkerError(
          `[SixbWorkflowWorker] Workflow run '${job.id}' and agent node '${completedNode.id}' must be waiting/succeeded to resume.`
        )
      }
      if (execution.status !== "succeeded" || !completedNode.output) {
        throw new WorkflowWorkerError(
          `[SixbWorkflowWorker] Agent execution '${completedNode.id}' must have a validated output to resume.`
        )
      }
      const agentNode = requireAgentNode(workflow, completedNode)
      const output = validateWorkflowAgentStepOutput({
        workflowId: workflow.id,
        agentStep: agentNode.agentStep,
        value: completedNode.output,
        valueTypesById,
      })
      const state = reconstructWorkflowState({
        workflow,
        run,
        nodeRuns: nodeRuns.nodes,
        upToNodeIndex: completedNode.nodeIndex,
        valueTypesById,
      })
      const recorder = new WorkflowRunRecorder({
        projectId: runtime.projectId,
        workflow,
        runId: job.id,
        workflowRuns: runtime.workflowRuns,
        observer: input.observer ?? noopWorkflowRunObserver,
        initialCompletedNodes: nodeRuns.nodes.filter(
          (nodeRun) =>
            nodeRun.nodeIndex <= completedNode.nodeIndex && nodeRun.status === "succeeded"
        ),
        alreadyStarted: true,
        execution: job.execution,
      })
      const logSession = resolveLoggingService(runtime.projectId, runtime.logging).startExecution({
        kind: "workflow",
        id: job.id,
      })
      const session = new WorkflowRunSession({
        runtime,
        job,
        workflow,
        signal,
        logSession,
        valueTypesById,
        workflowInputSnapshot: run.input,
        state,
        recorder,
        runner: new WorkflowNodeRunner({ recorder, executors: options.executors }),
        onRunFailed: input.onRunFailed,
      })
      await runtime.workflowRuns.resume({
        projectId: runtime.projectId,
        id: job.id,
        execution: job.execution,
      })
      session.markSideEffectBoundaryPassed()
      const outputRecord: Record<string, unknown> = { ...output }
      state.current = outputRecord
      state.currentSnapshot = completedNode.output
      state.steps[agentNode.key] = outputRecord
      session.resumeFromIndex = completedNode.nodeIndex + 1
      return session
    }
    const workflowInterventions = runtime.storage.workflowInterventions

    if (!workflowInterventions) {
      throw new WorkflowWorkerError(
        `[SixbWorkflowWorker] Workflow '${job.workflowId}' resume requires storage.workflowInterventions.`
      )
    }

    throwIfAborted(signal)

    const intervention = await requireInterventionRecord({
      storage: workflowInterventions,
      projectId: runtime.projectId,
      id: job.resume.interventionId,
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

    if (run.status === "running") {
      return WorkflowRunSession.recoverRunning(input, options)
    }

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
        `[SixbWorkflowWorker] Workflow run '${job.id}' must be waiting to resume.`
      )
    }

    if (waitingNode.status !== "waiting") {
      throw new WorkflowWorkerError(
        `[SixbWorkflowWorker] Workflow node run '${waitingNode.id}' must be waiting to resume.`
      )
    }

    if (intervention.status !== "submitted" || !intervention.response) {
      throw new WorkflowWorkerError(
        `[SixbWorkflowWorker] Workflow intervention '${intervention.id}' must be submitted to resume.`
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
      execution: job.execution,
    })
    const logSession = resolveLoggingService(runtime.projectId, runtime.logging).startExecution({
      kind: "workflow",
      id: job.id,
    })
    const session = new WorkflowRunSession({
      runtime,
      job,
      workflow,
      signal,
      logSession,
      valueTypesById,
      workflowInputSnapshot: run.input,
      state,
      recorder,
      runner: new WorkflowNodeRunner({
        recorder,
        executors: options.executors,
      }),
      onRunFailed: input.onRunFailed,
    })

    await runtime.workflowRuns.resume({
      projectId: runtime.projectId,
      id: job.id,
      execution: job.execution,
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
    state.currentSnapshot = responseSnapshot
    state.steps[interventionNode.key] = responseOutput
    session.resumeFromIndex = intervention.nodeIndex + 1

    return session
  }

  private resumeFromIndex = 0

  async start(): Promise<void> {
    if (this.dependencies.recorder.hasStarted) {
      return
    }
    await this.dependencies.recorder.startRun({
      input: this.dependencies.workflowInputSnapshot,
      source: this.dependencies.job.source,
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
          logSession: this.dependencies.logSession,
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

  flushLogs(): Promise<void> {
    return this.dependencies.logSession.flush()
  }

  private markSideEffectBoundaryPassed(): void {
    this.sideEffectBoundaryPassed = true
  }

  private async finishWorkflowRun(): Promise<WorkflowRunRecord> {
    try {
      return await this.dependencies.recorder.finishRunSucceeded(
        this.dependencies.state.currentSnapshot
      )
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
        onTransition:
          input.status === "failed"
            ? (run) => this.dependencies.onRunFailed?.(input.error, run)
            : undefined,
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
    throw new WorkflowWorkerError(`[SixbWorkflowWorker] Unknown workflow '${job.workflowId}'.`)
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
      `[SixbWorkflowWorker] Workflow intervention '${input.id}' not found.`
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
    throw new WorkflowWorkerError(`[SixbWorkflowWorker] Workflow run '${input.id}' not found.`)
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
    throw new WorkflowWorkerError(`[SixbWorkflowWorker] Workflow node run '${input.id}' not found.`)
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
      `[SixbWorkflowWorker] Workflow resume job for '${input.job.workflowId}' does not match run '${input.run.workflowId}'.`
    )
  }

  if (
    input.intervention.workflowId !== input.workflow.id ||
    input.intervention.workflowRunId !== input.job.id
  ) {
    throw new WorkflowWorkerError(
      `[SixbWorkflowWorker] Workflow intervention '${input.intervention.id}' does not match run '${input.job.id}'.`
    )
  }

  if (
    input.waitingNode.workflowId !== input.workflow.id ||
    input.waitingNode.workflowRunId !== input.job.id ||
    input.waitingNode.id !== input.intervention.nodeRunId
  ) {
    throw new WorkflowWorkerError(
      `[SixbWorkflowWorker] Workflow node run '${input.waitingNode.id}' does not match intervention '${input.intervention.id}'.`
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
      `[SixbWorkflowWorker] Workflow '${workflow.id}' does not contain intervention node '${intervention.nodeId}' at index ${intervention.nodeIndex}.`
    )
  }

  return node
}

function requireAgentNode(
  workflow: WorkflowDefinition,
  nodeRun: WorkflowNodeRunRecord
): WorkflowAgentNodeDefinition {
  const node = workflow.nodes[nodeRun.nodeIndex]
  if (
    !node ||
    node.type !== "agent" ||
    node.id !== nodeRun.nodeId ||
    node.key !== nodeRun.nodeKey
  ) {
    throw new WorkflowWorkerError(
      `[SixbWorkflowWorker] Workflow '${workflow.id}' does not contain agent node '${nodeRun.nodeId}' at index ${nodeRun.nodeIndex}.`
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
    currentSnapshot: input.run.input,
    steps: {},
  }
  const nodeRunsByIndex = new Map(input.nodeRuns.map((nodeRun) => [nodeRun.nodeIndex, nodeRun]))

  for (let nodeIndex = 0; nodeIndex < input.upToNodeIndex; nodeIndex++) {
    const node = input.workflow.nodes[nodeIndex]
    const nodeRun = nodeRunsByIndex.get(nodeIndex)
    if (!node || !nodeRun) {
      throw new WorkflowWorkerError(
        `[SixbWorkflowWorker] Workflow run '${input.run.id}' is missing node run at index ${nodeIndex}.`
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
      `[SixbWorkflowWorker] Workflow node run '${input.nodeRun.id}' must be succeeded to reconstruct workflow state.`
    )
  }

  const stateOutput = restoreCompletedNodeOutput(input)
  if (!stateOutput) return

  input.state.current = stateOutput
  input.state.currentSnapshot = input.nodeRun.output ?? {}
  input.state.steps[input.node.key] = stateOutput
}

function restoreCompletedNodeOutput(input: {
  readonly workflowId: string
  readonly node: WorkflowNodeDefinition
  readonly nodeRun: WorkflowNodeRunRecord
  readonly valueTypesById: ReadonlyMap<string, ValueType>
}): Record<string, unknown> | null {
  const output = input.nodeRun.output ?? {}

  switch (input.node.type) {
    case "action":
      return null
    case "step":
      return {
        ...validateWorkflowStepOutput({
          workflowId: input.workflowId,
          step: input.node.step,
          value: output,
          valueTypesById: input.valueTypesById,
        }),
      }
    case "agent":
      return {
        ...validateWorkflowAgentStepOutput({
          workflowId: input.workflowId,
          agentStep: input.node.agentStep,
          value: output,
          valueTypesById: input.valueTypesById,
        }),
      }
    case "intervention":
      return {
        ...validateWorkflowInterventionResponse({
          workflowId: input.workflowId,
          intervention: input.node.intervention,
          value: output,
          valueTypesById: input.valueTypesById,
        }),
      }
  }
}

function analyzeRunningWorkflowHistory(input: {
  readonly workflow: WorkflowDefinition
  readonly nodeRuns: readonly WorkflowNodeRunRecord[]
}): {
  readonly completed: readonly WorkflowNodeRunRecord[]
  readonly running?: WorkflowNodeRunRecord
  readonly resumeFromIndex: number
} {
  const completed: WorkflowNodeRunRecord[] = []
  let running: WorkflowNodeRunRecord | undefined

  for (let index = 0; index < input.nodeRuns.length; index++) {
    const { nodeRun } = requireWorkflowHistoryEntry({
      workflow: input.workflow,
      node: input.workflow.nodes[index],
      nodeRun: input.nodeRuns[index],
      expectedIndex: index,
    })

    if (nodeRun.status === "succeeded") {
      completed.push(nodeRun)
      continue
    }

    const isLatestHistoryEntry = index === input.nodeRuns.length - 1
    if (nodeRun.status === "running" && isLatestHistoryEntry) {
      running = nodeRun
      continue
    }

    throw new WorkflowWorkerError(
      `[SixbWorkflowWorker] Running workflow '${input.workflow.id}' has an unrecoverable node '${nodeRun.id}' in status '${nodeRun.status}'.`
    )
  }

  const resumeFromIndex = running?.nodeIndex ?? completed.length
  return {
    completed,
    ...(running ? { running } : {}),
    resumeFromIndex,
  }
}

function requireWorkflowHistoryEntry(input: {
  readonly workflow: WorkflowDefinition
  readonly node: WorkflowNodeDefinition | undefined
  readonly nodeRun: WorkflowNodeRunRecord | undefined
  readonly expectedIndex: number
}): {
  readonly node: WorkflowNodeDefinition
  readonly nodeRun: WorkflowNodeRunRecord
} {
  const { workflow, node, nodeRun, expectedIndex } = input
  if (!node || !nodeRun) {
    throw new WorkflowWorkerError(
      `[SixbWorkflowWorker] Workflow '${workflow.id}' has an incomplete node history at index ${expectedIndex}.`
    )
  }

  const mismatch = [
    { field: "nodeIndex", actual: nodeRun.nodeIndex, expected: expectedIndex },
    { field: "workflowId", actual: nodeRun.workflowId, expected: workflow.id },
    { field: "nodeType", actual: nodeRun.nodeType, expected: node.type },
    { field: "nodeId", actual: nodeRun.nodeId, expected: node.id },
    { field: "nodeKey", actual: nodeRun.nodeKey, expected: node.key },
  ].find(({ actual, expected }) => actual !== expected)

  if (mismatch) {
    throw new WorkflowWorkerError(
      `[SixbWorkflowWorker] Workflow '${workflow.id}' node history has ${mismatch.field} '${mismatch.actual}' at index ${expectedIndex}; expected '${mismatch.expected}'.`
    )
  }

  return { node, nodeRun }
}

function createWorkflowBookkeepingError(input: {
  readonly workflowId: string
  readonly runId: string
  readonly cause: unknown
}): Error {
  return new WorkflowWorkerError(
    `[SixbWorkflowWorker] Workflow '${input.workflowId}' executed side effects, but failed to finalize workflow run '${input.runId}'. The workflow state may need repair.`,
    { cause: input.cause }
  )
}
