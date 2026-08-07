import type { WorkflowIOSnapshot, WorkflowNodeDefinition } from "@sixb/core/internal/workflows"
import type { WorkflowRunRecord } from "@sixb/core/storage"
import { WorkflowWorkerError } from "../errors"
import { throwIfAborted } from "../normalize"
import type { WorkflowRunRecorder } from "../recorder"
import type {
  WorkflowNodeExecutionContext,
  WorkflowNodeExecutor,
  WorkflowNodeExecutorRegistry,
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
    const prepared = await executor.prepare({
      node: input.node,
      context: input.context,
    })
    const nodeRun = await this.dependencies.recorder.startNode({
      nodeIndex: input.nodeIndex,
      nodeType: input.node.type,
      nodeId: input.node.id,
      nodeKey: input.node.key,
      input: prepared.inputSnapshot,
    })

    throwIfAborted(input.context.signal)

    const outcome = await executor.execute({
      node: input.node,
      nodeIndex: input.nodeIndex,
      nodeRun,
      prepared,
      context: input.context,
    })

    if (outcome.status === "waiting") {
      if ("agentExecution" in outcome) {
        if (outcome.agentExecution.nodeRunId !== nodeRun.id || outcome.nodeRun.id !== nodeRun.id) {
          throw new WorkflowWorkerError(
            `[SixbWorkflowWorker] Workflow '${input.context.workflow.id}' agent node '${input.node.id}' parked a different node run.`
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
        throw new WorkflowWorkerError(
          `[SixbWorkflowWorker] Workflow '${input.context.workflow.id}' intervention node '${input.node.id}' returned an intervention for a different node run.`
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

    assertStatePatchIsPersistable(outcome.statePatch, outcome.outputSnapshot)

    await this.dependencies.recorder.finishNodeSucceeded({
      nodeRunId: nodeRun.id,
      output: outcome.outputSnapshot,
    })

    applyStatePatch(input.context.state, outcome.statePatch, outcome.outputSnapshot)

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

export type WorkflowNodeRunResult =
  | { readonly status: "succeeded" }
  | { readonly status: "waiting"; readonly run: WorkflowRunRecord }

function assertStatePatchIsPersistable(
  patch: WorkflowNodeStatePatch | undefined,
  outputSnapshot: WorkflowIOSnapshot | undefined
): void {
  if (patch?.current !== undefined) {
    requireOutputSnapshot(outputSnapshot)
  }
}

function applyStatePatch(
  state: WorkflowNodeExecutionContext["state"],
  patch: WorkflowNodeStatePatch | undefined,
  outputSnapshot: WorkflowIOSnapshot | undefined
): void {
  if (!patch) {
    return
  }

  if (patch.current !== undefined) {
    state.current = patch.current
    state.currentSnapshot = requireOutputSnapshot(outputSnapshot)
  }

  if (patch.steps) {
    Object.assign(state.steps, patch.steps)
  }
}

function requireOutputSnapshot(outputSnapshot: WorkflowIOSnapshot | undefined): WorkflowIOSnapshot {
  if (outputSnapshot === undefined) {
    throw new WorkflowWorkerError(
      "[SixbWorkflowWorker] A workflow node that advances the dataflow must persist its output snapshot."
    )
  }
  return outputSnapshot
}
