import type { WorkflowNodeDefinition } from "@pario/core"
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

    if (outcome.waitForIntervention) {
      if (outcome.waitForIntervention.nodeRunId !== nodeRun.id) {
        throw new WorkflowWorkerError(
          `[ParioWorkflowWorker] Workflow '${input.context.workflow.id}' intervention node '${input.node.id}' returned an intervention for a different node run.`
        )
      }

      await this.dependencies.recorder.recordInterventionRequested(outcome.waitForIntervention)
      await this.dependencies.recorder.waitActiveNode({
        nodeRunId: nodeRun.id,
        waitingAt: outcome.waitForIntervention.requestedAt,
      })

      return {
        status: "waiting",
        waitingAt: outcome.waitForIntervention.requestedAt,
      }
    }

    await this.dependencies.recorder.finishNodeSucceeded({
      nodeRunId: nodeRun.id,
      output: outcome.outputSnapshot,
    })

    applyStatePatch(input.context.state, outcome.statePatch)
    return { status: "completed" }
  }

  private executorFor<TNode extends WorkflowNodeDefinition>(
    node: TNode
  ): WorkflowNodeExecutor<TNode> {
    return this.dependencies.executors[node.type] as WorkflowNodeExecutor<TNode>
  }
}

type WorkflowNodeRunResult =
  | { readonly status: "completed" }
  | { readonly status: "waiting"; readonly waitingAt: Date }

function applyStatePatch(
  state: WorkflowNodeExecutionContext["state"],
  patch: WorkflowNodeStatePatch | undefined
): void {
  if (!patch) {
    return
  }

  if (patch.current !== undefined) {
    state.current = patch.current
  }

  if (patch.steps) {
    Object.assign(state.steps, patch.steps)
  }
}
