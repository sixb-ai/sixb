import type { ValueType, WorkflowDefinition } from "@sixb/core"
import { captureSixbFailure, createSixbError } from "@sixb/core/internal/errors"
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
  SixbFailure,
  WorkflowInterventionRecord,
  WorkflowInterventionStorage,
  WorkflowNodeRunRecord,
  WorkflowRunFailureCode,
  WorkflowRunRecord,
  WorkflowRunStorage,
} from "@sixb/core/storage"
import { WORKFLOW_RUN_FAILURE_CODES } from "@sixb/core/storage"
import { statusForFailure, throwIfAborted } from "../normalize"
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
      throw createSixbError(
        "internal.unexpected",
        `[SixbWorkflowWorker] Running workflow '${job.id}' can only be recovered by a queue-owned execution.`,
        { details: { workflowId: job.workflowId, runId: job.id } }
      )
    }

    const signal = input.signal ?? new AbortController().signal
    const workflow = requireWorkflow(runtime.sixb.workflows.getById(job.workflowId), job)
    const valueTypesById = runtime.ontology.getValueTypesById()
    throwIfAborted(signal)

    const run = await requireWorkflowRun({
      workflowRuns: runtime.workflowRuns,
      projectId: runtime.projectId,
      workflowId: workflow.id,
      id: job.id,
    })
    if (run.workflowId !== workflow.id || run.status !== "running") {
      throw createSixbError(
        "internal.unexpected",
        `[SixbWorkflowWorker] Workflow run '${job.id}' is not a running '${workflow.id}' execution.`,
        { details: { workflowId: workflow.id, runId: job.id } }
      )
    }

    const listed = await runtime.workflowRuns.nodes.list({
      projectId: runtime.projectId,
      workflowRunId: run.id,
      order: "asc",
    })
    const recovery = analyzeRunningWorkflowHistory({
      workflow,
      workflowRunId: run.id,
      nodeRuns: listed.nodes,
    })
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
        workflowId: workflow.id,
        id: job.id,
      })
      const completedNode = await requireWorkflowNodeRun({
        workflowRuns: runtime.workflowRuns,
        projectId: runtime.projectId,
        workflowId: workflow.id,
        workflowRunId: job.id,
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
        throw createSixbError(
          "internal.unexpected",
          `[SixbWorkflowWorker] Agent node '${completedNode.id}' does not belong to workflow run '${run.id}'.`,
          {
            details: {
              workflowId: workflow.id,
              workflowRunId: run.id,
              nodeId: completedNode.nodeId,
              nodeRunId: completedNode.id,
              ...(execution ? { agentId: execution.agentId } : {}),
            },
          }
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
        throw createSixbError(
          "internal.unexpected",
          `[SixbWorkflowWorker] Workflow run '${job.id}' and agent node '${completedNode.id}' must be waiting/succeeded to resume.`,
          {
            details: {
              agentId: execution.agentId,
              workflowId: workflow.id,
              workflowRunId: run.id,
              nodeId: completedNode.nodeId,
              nodeRunId: completedNode.id,
            },
          }
        )
      }
      if (execution.status !== "succeeded" || !completedNode.output) {
        throw createSixbError(
          "internal.unexpected",
          `[SixbWorkflowWorker] Agent execution '${completedNode.id}' must have a validated output to resume.`,
          {
            details: {
              agentId: execution.agentId,
              workflowId: workflow.id,
              workflowRunId: run.id,
              nodeId: completedNode.nodeId,
              nodeRunId: completedNode.id,
            },
          }
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
      throw createSixbError(
        "internal.unexpected",
        `[SixbWorkflowWorker] Workflow '${job.workflowId}' resume requires storage.workflowInterventions.`,
        {
          details: {
            workflowId: job.workflowId,
            workflowRunId: job.id,
            interventionRecordId: job.resume.interventionId,
          },
        }
      )
    }

    throwIfAborted(signal)

    const intervention = await requireInterventionRecord({
      storage: workflowInterventions,
      projectId: runtime.projectId,
      workflowId: workflow.id,
      workflowRunId: job.id,
      id: job.resume.interventionId,
    })
    const run = await requireWorkflowRun({
      workflowRuns: runtime.workflowRuns,
      projectId: runtime.projectId,
      workflowId: workflow.id,
      id: job.id,
    })
    const waitingNode = await requireWorkflowNodeRun({
      workflowRuns: runtime.workflowRuns,
      projectId: runtime.projectId,
      workflowId: workflow.id,
      workflowRunId: job.id,
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
      throw createSixbError(
        "internal.unexpected",
        `[SixbWorkflowWorker] Workflow run '${job.id}' must be waiting to resume.`,
        {
          details: {
            workflowId: workflow.id,
            workflowRunId: run.id,
            nodeRunId: waitingNode.id,
            interventionId: intervention.interventionId,
            interventionRecordId: intervention.id,
          },
        }
      )
    }

    if (waitingNode.status !== "waiting") {
      throw createSixbError(
        "internal.unexpected",
        `[SixbWorkflowWorker] Workflow node run '${waitingNode.id}' must be waiting to resume.`,
        {
          details: {
            workflowId: workflow.id,
            workflowRunId: run.id,
            nodeId: waitingNode.nodeId,
            nodeRunId: waitingNode.id,
            interventionId: intervention.interventionId,
            interventionRecordId: intervention.id,
          },
        }
      )
    }

    if (intervention.status !== "submitted" || !intervention.response) {
      throw createSixbError(
        "internal.unexpected",
        `[SixbWorkflowWorker] Workflow intervention '${intervention.id}' must be submitted to resume.`,
        {
          details: {
            workflowId: workflow.id,
            workflowRunId: run.id,
            nodeId: waitingNode.nodeId,
            nodeRunId: waitingNode.id,
            interventionId: intervention.interventionId,
            interventionRecordId: intervention.id,
          },
        }
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
    await this.dependencies.recorder.startRun()
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

    const at = new Date()
    const activeNodeRunId = this.dependencies.recorder.activeNodeId
    const failure = captureSixbFailure(error, {
      allowedCodes: WORKFLOW_RUN_FAILURE_CODES,
      defaultCode: status === "cancelled" ? "runtime.cancelled" : "internal.unexpected",
      details: {
        workflowId: this.dependencies.workflow.id,
        workflowRunId: this.dependencies.job.id,
        ...(activeNodeRunId ? { nodeRunId: activeNodeRunId } : {}),
      },
      at,
    })
    await this.dependencies.recorder.finishActiveNodeAfterError({
      status,
      error: failure,
    })

    await this.finishWorkflowRunAfterError({ reportedError: error, failure, status })
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
    readonly reportedError: unknown
    readonly failure: SixbFailure<WorkflowRunFailureCode>
    readonly status: "failed" | "cancelled"
  }): Promise<void> {
    const finishError = await this.dependencies.recorder
      .finishRunAfterError({
        status: input.status,
        error: input.failure,
        onTransition:
          input.status === "failed"
            ? (run) => this.dependencies.onRunFailed?.(input.reportedError, run, input.failure)
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
  job: { readonly id: string; readonly workflowId: string }
): WorkflowDefinition {
  if (!workflow) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbWorkflowWorker] Unknown workflow '${job.workflowId}'.`,
      { details: { workflowId: job.workflowId, runId: job.id } }
    )
  }

  return workflow
}

async function requireInterventionRecord(input: {
  readonly storage: WorkflowInterventionStorage
  readonly projectId: string
  readonly workflowId: string
  readonly workflowRunId: string
  readonly id: string
}): Promise<WorkflowInterventionRecord> {
  const intervention = await input.storage.getById({
    projectId: input.projectId,
    id: input.id,
  })

  if (!intervention) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbWorkflowWorker] Workflow intervention '${input.id}' not found.`,
      {
        details: {
          workflowId: input.workflowId,
          workflowRunId: input.workflowRunId,
          interventionRecordId: input.id,
        },
      }
    )
  }

  return intervention
}

async function requireWorkflowRun(input: {
  readonly workflowRuns: WorkflowRunStorage
  readonly projectId: string
  readonly workflowId: string
  readonly id: string
}): Promise<WorkflowRunRecord> {
  const run = await input.workflowRuns.getById({
    projectId: input.projectId,
    id: input.id,
  })

  if (!run) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbWorkflowWorker] Workflow run '${input.id}' not found.`,
      { details: { workflowId: input.workflowId, runId: input.id } }
    )
  }

  return run
}

async function requireWorkflowNodeRun(input: {
  readonly workflowRuns: WorkflowRunStorage
  readonly projectId: string
  readonly workflowId: string
  readonly workflowRunId: string
  readonly id: string
}): Promise<WorkflowNodeRunRecord> {
  const node = await input.workflowRuns.nodes.getById({
    projectId: input.projectId,
    id: input.id,
  })

  if (!node) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbWorkflowWorker] Workflow node run '${input.id}' not found.`,
      {
        details: {
          workflowId: input.workflowId,
          workflowRunId: input.workflowRunId,
          nodeRunId: input.id,
        },
      }
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
    throw createSixbError(
      "internal.unexpected",
      `[SixbWorkflowWorker] Workflow resume job for '${input.job.workflowId}' does not match run '${input.run.workflowId}'.`,
      { details: { workflowId: input.job.workflowId, runId: input.job.id } }
    )
  }

  if (
    input.intervention.workflowId !== input.workflow.id ||
    input.intervention.workflowRunId !== input.job.id
  ) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbWorkflowWorker] Workflow intervention '${input.intervention.id}' does not match run '${input.job.id}'.`,
      {
        details: {
          workflowId: input.workflow.id,
          workflowRunId: input.job.id,
          nodeRunId: input.intervention.nodeRunId,
          interventionId: input.intervention.interventionId,
          interventionRecordId: input.intervention.id,
        },
      }
    )
  }

  if (
    input.waitingNode.workflowId !== input.workflow.id ||
    input.waitingNode.workflowRunId !== input.job.id ||
    input.waitingNode.id !== input.intervention.nodeRunId
  ) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbWorkflowWorker] Workflow node run '${input.waitingNode.id}' does not match intervention '${input.intervention.id}'.`,
      {
        details: {
          workflowId: input.workflow.id,
          workflowRunId: input.job.id,
          nodeId: input.waitingNode.nodeId,
          nodeRunId: input.waitingNode.id,
          interventionId: input.intervention.interventionId,
          interventionRecordId: input.intervention.id,
        },
      }
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
    throw createSixbError(
      "internal.unexpected",
      `[SixbWorkflowWorker] Workflow '${workflow.id}' does not contain intervention node '${intervention.nodeId}' at index ${intervention.nodeIndex}.`,
      {
        details: {
          workflowId: workflow.id,
          workflowRunId: intervention.workflowRunId,
          nodeId: intervention.nodeId,
          nodeRunId: intervention.nodeRunId,
          interventionId: intervention.interventionId,
          interventionRecordId: intervention.id,
        },
      }
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
    throw createSixbError(
      "internal.unexpected",
      `[SixbWorkflowWorker] Workflow '${workflow.id}' does not contain agent node '${nodeRun.nodeId}' at index ${nodeRun.nodeIndex}.`,
      {
        details: {
          workflowId: workflow.id,
          workflowRunId: nodeRun.workflowRunId,
          nodeId: nodeRun.nodeId,
          nodeRunId: nodeRun.id,
        },
      }
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
      throw createSixbError(
        "internal.unexpected",
        `[SixbWorkflowWorker] Workflow run '${input.run.id}' is missing node run at index ${nodeIndex}.`,
        {
          details: {
            workflowId: input.workflow.id,
            workflowRunId: input.run.id,
            ...(node ? { nodeId: node.id } : {}),
          },
        }
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
    throw createSixbError(
      "internal.unexpected",
      `[SixbWorkflowWorker] Workflow node run '${input.nodeRun.id}' must be succeeded to reconstruct workflow state.`,
      {
        details: {
          workflowId: input.workflowId,
          workflowRunId: input.nodeRun.workflowRunId,
          nodeId: input.nodeRun.nodeId,
          nodeRunId: input.nodeRun.id,
        },
      }
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
  readonly workflowRunId: string
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
      workflowRunId: input.workflowRunId,
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

    throw createSixbError(
      "internal.unexpected",
      `[SixbWorkflowWorker] Running workflow '${input.workflow.id}' has an unrecoverable node '${nodeRun.id}' in status '${nodeRun.status}'.`,
      {
        details: {
          workflowId: input.workflow.id,
          workflowRunId: input.workflowRunId,
          nodeId: nodeRun.nodeId,
          nodeRunId: nodeRun.id,
        },
      }
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
  readonly workflowRunId: string
  readonly node: WorkflowNodeDefinition | undefined
  readonly nodeRun: WorkflowNodeRunRecord | undefined
  readonly expectedIndex: number
}): {
  readonly node: WorkflowNodeDefinition
  readonly nodeRun: WorkflowNodeRunRecord
} {
  const { workflow, workflowRunId, node, nodeRun, expectedIndex } = input
  if (!node || !nodeRun) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbWorkflowWorker] Workflow '${workflow.id}' has an incomplete node history at index ${expectedIndex}.`,
      {
        details: {
          workflowId: workflow.id,
          workflowRunId,
          ...(node ? { nodeId: node.id } : {}),
          ...(nodeRun ? { nodeRunId: nodeRun.id } : {}),
        },
      }
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
    throw createSixbError(
      "internal.unexpected",
      `[SixbWorkflowWorker] Workflow '${workflow.id}' node history has ${mismatch.field} '${mismatch.actual}' at index ${expectedIndex}; expected '${mismatch.expected}'.`,
      {
        details: {
          workflowId: workflow.id,
          workflowRunId,
          nodeId: node.id,
          nodeRunId: nodeRun.id,
        },
      }
    )
  }

  return { node, nodeRun }
}

function createWorkflowBookkeepingError(input: {
  readonly workflowId: string
  readonly runId: string
  readonly cause: unknown
}): Error {
  return createSixbError(
    "internal.unexpected",
    `[SixbWorkflowWorker] Workflow '${input.workflowId}' executed side effects, but failed to finalize workflow run '${input.runId}'. The workflow state may need repair.`,
    {
      cause: input.cause,
      details: { workflowId: input.workflowId, runId: input.runId },
    }
  )
}
