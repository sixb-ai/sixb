import { ActionRunFailedError } from "@sixb/core"
import { createSixbError } from "@sixb/core/internal/errors"
import {
  createWorkflowNodeFailure,
  type WorkflowIOSnapshot,
  type WorkflowNodeDefinition,
  type WorkflowNodeFailureIdentity,
} from "@sixb/core/internal/workflows"
import type { WorkflowRunRecord } from "@sixb/core/storage"
import { isAbortError, throwIfAborted } from "../normalize"
import type { WorkflowRunRecorder } from "../recorder"
import type {
  PreparedWorkflowNode,
  WorkflowNodeExecutionContext,
  WorkflowNodeExecutor,
  WorkflowNodeExecutorRegistry,
  WorkflowNodeOutcome,
  WorkflowNodeStatePatch,
} from "./node-executor"

export class WorkflowNodeRunner {
  constructor(
    private readonly dependencies: {
      readonly recorder: WorkflowRunRecorder
      readonly executors: WorkflowNodeExecutorRegistry
    }
  ) {}

  async runNode(input: {
    readonly node: WorkflowNodeDefinition
    readonly nodeIndex: number
    readonly context: WorkflowNodeExecutionContext
  }): Promise<WorkflowNodeRunResult> {
    const executor = this.executorFor(input.node)
    let prepared: PreparedWorkflowNode
    try {
      prepared = await executor.prepare({
        node: input.node,
        context: input.context,
      })
    } catch (error) {
      throwNodeExecutionError(error, input)
    }
    const nodeRun = await this.dependencies.recorder.startNode({
      nodeIndex: input.nodeIndex,
      nodeType: input.node.type,
      nodeId: input.node.id,
      nodeKey: input.node.key,
      input: prepared.inputSnapshot,
    })

    throwIfAborted(input.context.signal)

    let outcome: WorkflowNodeOutcome
    try {
      outcome = await executor.execute({
        node: input.node,
        nodeIndex: input.nodeIndex,
        nodeRun,
        prepared,
        context: input.context,
      })
    } catch (error) {
      throwNodeExecutionError(error, input, nodeRun.id)
    }

    if (outcome.status === "waiting") {
      if ("agentExecution" in outcome) {
        if (outcome.agentExecution.nodeRunId !== nodeRun.id || outcome.nodeRun.id !== nodeRun.id) {
          throw createSixbError(
            "internal.unexpected",
            `[SixbWorkflowWorker] Workflow '${input.context.workflow.id}' agent node '${input.node.id}' parked a different node run.`,
            {
              details: {
                agentStepId: input.node.id,
                workflowId: input.context.workflow.id,
                workflowRunId: input.context.job.id,
                nodeId: input.node.id,
                nodeRunId: nodeRun.id,
              },
            }
          )
        }
        await this.dependencies.recorder.recordParkedNode({
          node: outcome.nodeRun,
          run: outcome.run,
          waitingAt: outcome.waitingAt,
        })
        return { status: "waiting", run: outcome.run }
      }

      if (outcome.intervention.nodeRunId !== nodeRun.id) {
        throw createSixbError(
          "internal.unexpected",
          `[SixbWorkflowWorker] Workflow '${input.context.workflow.id}' intervention node '${input.node.id}' returned an intervention for a different node run.`,
          {
            details: {
              workflowId: input.context.workflow.id,
              workflowRunId: input.context.job.id,
              nodeId: input.node.id,
              nodeRunId: nodeRun.id,
              interventionId: outcome.intervention.interventionId,
              interventionRecordId: outcome.intervention.id,
            },
          }
        )
      }

      await this.dependencies.recorder.recordInterventionRequested(outcome.intervention)
      await this.dependencies.recorder.waitActiveNode({
        nodeRunId: nodeRun.id,
        waitingAt: outcome.intervention.requestedAt,
      })
      const run = await this.dependencies.recorder.waitRun({
        waitingAt: outcome.intervention.requestedAt,
      })

      return {
        status: "waiting",
        run,
      }
    }

    const details = {
      workflowId: input.context.workflow.id,
      workflowRunId: input.context.job.id,
      nodeId: input.node.id,
      nodeRunId: nodeRun.id,
    }
    assertStatePatchIsPersistable(outcome.statePatch, outcome.outputSnapshot, details)

    try {
      await this.dependencies.recorder.finishNodeSucceeded({
        nodeRunId: nodeRun.id,
        output: outcome.outputSnapshot,
      })
    } catch (error) {
      throw createSixbError(
        "internal.unexpected",
        `[SixbWorkflowWorker] Workflow '${input.context.workflow.id}' node '${input.node.id}' completed, but failed to finalize node run '${nodeRun.id}'. The node run record may need repair.`,
        {
          cause: error,
          details: {
            workflowId: input.context.workflow.id,
            workflowRunId: input.context.job.id,
            nodeId: input.node.id,
            nodeRunId: nodeRun.id,
          },
        }
      )
    }

    applyStatePatch(input.context.state, outcome.statePatch, outcome.outputSnapshot, details)

    return {
      status: "succeeded",
    }
  }

  private executorFor<TNode extends WorkflowNodeDefinition>(
    node: TNode
  ): WorkflowNodeExecutor<TNode> {
    return this.dependencies.executors[node.type] as WorkflowNodeExecutor<TNode>
  }
}

function throwNodeExecutionError(
  error: unknown,
  input: {
    readonly node: WorkflowNodeDefinition
    readonly context: WorkflowNodeExecutionContext
  },
  nodeRunId?: string
): never {
  if (input.context.signal.aborted || isAbortError(error)) {
    throw error
  }

  throw createWorkflowNodeFailure(error, {
    workflowId: input.context.workflow.id,
    workflowRunId: input.context.job.id,
    nodeId: input.node.id,
    ...(nodeRunId ? { nodeRunId } : {}),
    child: workflowNodeFailureChild(input.node, error),
  })
}

function workflowNodeFailureChild(
  node: WorkflowNodeDefinition,
  error: unknown
): WorkflowNodeFailureIdentity["child"] {
  switch (node.type) {
    case "step":
      return { type: "step", stepId: node.step.id }
    case "action":
      return {
        type: "action",
        actionId: node.action.id,
        ...(error instanceof ActionRunFailedError ? { actionRunId: error.runId } : {}),
      }
    case "agent":
      return { type: "agent", agentStepId: node.agentStep.id }
    case "intervention":
      return { type: "intervention", interventionId: node.intervention.id }
  }
}

export type WorkflowNodeRunResult =
  | { readonly status: "succeeded" }
  | { readonly status: "waiting"; readonly run: WorkflowRunRecord }

function assertStatePatchIsPersistable(
  patch: WorkflowNodeStatePatch | undefined,
  outputSnapshot: WorkflowIOSnapshot | undefined,
  details: Readonly<Record<string, string>>
): void {
  if (patch?.current !== undefined) {
    requireOutputSnapshot(outputSnapshot, details)
  }
}

function applyStatePatch(
  state: WorkflowNodeExecutionContext["state"],
  patch: WorkflowNodeStatePatch | undefined,
  outputSnapshot: WorkflowIOSnapshot | undefined,
  details: Readonly<Record<string, string>>
): void {
  if (!patch) {
    return
  }

  if (patch.current !== undefined) {
    state.current = patch.current
    state.currentSnapshot = requireOutputSnapshot(outputSnapshot, details)
  }

  if (patch.steps) {
    Object.assign(state.steps, patch.steps)
  }
}

function requireOutputSnapshot(
  outputSnapshot: WorkflowIOSnapshot | undefined,
  details: Readonly<Record<string, string>>
): WorkflowIOSnapshot {
  if (outputSnapshot === undefined) {
    throw createSixbError(
      "internal.unexpected",
      "[SixbWorkflowWorker] A workflow node that advances the dataflow must persist its output snapshot.",
      { details }
    )
  }
  return outputSnapshot
}
