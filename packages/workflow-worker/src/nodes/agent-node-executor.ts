import { SixbError } from "@sixb/core/errors"
import { workflowAgentNodeQueueJobId } from "@sixb/core/internal/agents"
import { reportBackgroundTaskFailure } from "@sixb/core/internal/error-reporting"
import type { WorkflowAgentNodeDefinition } from "@sixb/core/internal/workflows"
import {
  snapshotWorkflowAgentStepInput,
  validateWorkflowAgentStepInput,
} from "@sixb/core/internal/workflows"
import type { WorkflowNodeExecutor } from "../execution/node-executor"
import { throwIfAborted } from "../normalize"
import { callWorkflowMapper, requireRecordInput } from "./mapper"

export const agentNodeExecutor: WorkflowNodeExecutor<WorkflowAgentNodeDefinition> = {
  type: "agent",

  prepare({ node, context }) {
    const rawInput =
      node.mapper === undefined
        ? context.state.current
        : callWorkflowMapper({
            mapper: node.mapper,
            workflowId: context.workflow.id,
            nodeId: node.id,
            workflowInput: context.state.workflowInput,
            steps: context.state.steps,
          })
    const nodeInput = requireRecordInput({
      value: rawInput,
      workflowId: context.workflow.id,
      nodeId: node.id,
    })
    const agentInput = validateWorkflowAgentStepInput({
      workflowId: context.workflow.id,
      agentStep: node.agentStep,
      value: nodeInput,
      valueTypesById: context.valueTypesById,
    })
    return {
      input: agentInput,
      inputSnapshot: snapshotWorkflowAgentStepInput({
        workflowId: context.workflow.id,
        agentStep: node.agentStep,
        value: agentInput,
        valueTypesById: context.valueTypesById,
      }),
    }
  },

  async execute({ node, nodeRun, prepared, context }) {
    const input = requireRecordInput({
      value: prepared.input,
      workflowId: context.workflow.id,
      nodeId: node.id,
    })
    const prompt = await node.agentStep.prompt({ input })
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw new SixbError(
        "workflow.failed",
        `[SixbWorkflowWorker] Workflow '${context.workflow.id}' agent node '${node.id}' prompt must return a non-empty string.`
      )
    }
    throwIfAborted(context.signal)
    const waitingAt = new Date()
    const parked = await context.runtime.storage.transaction(async (tx) => {
      const workflowRuns = tx.workflowRuns
      if (!workflowRuns) {
        throw new SixbError(
          "workflow.failed",
          `[SixbWorkflowWorker] Workflow '${context.workflow.id}' agent node '${node.id}' requires storage.workflowRuns.`
        )
      }
      const agentExecution = await workflowRuns.agentNodes.create({
        projectId: context.runtime.projectId,
        nodeRunId: nodeRun.id,
        agentId: node.agentStep.agent.id,
        prompt,
        createdAt: waitingAt,
      })
      const waitingNode = await workflowRuns.nodes.wait({
        projectId: context.runtime.projectId,
        id: nodeRun.id,
        waitingAt,
        executionToken: context.job.execution?.token,
      })
      const waitingRun = await workflowRuns.wait({
        projectId: context.runtime.projectId,
        id: context.job.id,
        waitingAt,
        executionToken: context.job.execution?.token,
      })
      return { agentExecution, nodeRun: waitingNode, run: waitingRun }
    })

    context.markSideEffectBoundaryPassed()
    try {
      await context.runtime.queues.agents.enqueue({
        projectId: context.runtime.projectId,
        jobs: [
          {
            id: workflowAgentNodeQueueJobId(nodeRun.id),
            type: "agent.workflow-node.requested",
            payload: { agentId: node.agentStep.agent.id, nodeRunId: nodeRun.id },
          },
        ],
      })
    } catch (error) {
      // The node is parked as waiting and durable; the agent worker's scan is what retries this.
      // Until it does, the workflow sits at this node with nothing recording why.
      reportBackgroundTaskFailure(context.runtime, error, {
        projectId: context.runtime.projectId,
        task: "agent.dispatch",
        subject: nodeRun.id,
      })
    }

    return { status: "waiting", ...parked, waitingAt }
  },
}
