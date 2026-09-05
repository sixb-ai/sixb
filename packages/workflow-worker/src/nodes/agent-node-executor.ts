import { randomUUID } from "node:crypto"
import { createAgentExecutionRecord } from "@sixb/core/internal/agent-execution"
import {
  ensureManagedAgentExecutionIdentity,
  workflowAgentNodeQueueJobId,
} from "@sixb/core/internal/agents"
import { createSixbError } from "@sixb/core/internal/errors"
import type { WorkflowAgentNodeDefinition } from "@sixb/core/internal/workflows"
import {
  snapshotWorkflowAgentStepInput,
  validateWorkflowAgentStepInput,
  workflowAgentStepActorId,
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
            workflowRunId: context.job.id,
            nodeId: node.id,
            workflowInput: context.state.workflowInput,
            steps: context.state.steps,
          })
    const nodeInput = requireRecordInput({
      value: rawInput,
      workflowId: context.workflow.id,
      workflowRunId: context.job.id,
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
      workflowRunId: context.job.id,
      nodeId: node.id,
      nodeRunId: nodeRun.id,
    })
    const prompt = await node.agentStep.prompt({ input })
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw createSixbError(
        "internal.unexpected",
        `[SixbWorkflowWorker] Workflow '${context.workflow.id}' agent node '${node.id}' prompt must return a non-empty string.`,
        {
          details: {
            agentStepId: node.agentStep.id,
            workflowId: context.workflow.id,
            workflowRunId: context.job.id,
            nodeId: node.id,
            nodeRunId: nodeRun.id,
          },
        }
      )
    }
    throwIfAborted(context.signal)
    const actorId = workflowAgentStepActorId(context.workflow.id, node.agentStep.id)
    const identity = await ensureManagedAgentExecutionIdentity({
      auth: context.runtime.storage.auth,
      projectId: context.runtime.projectId,
      actorId: actorId,
      name: `Workflow ${context.workflow.id} · ${node.agentStep.id}`,
      description: `Managed service account for workflow '${context.workflow.id}' agent step '${node.agentStep.id}'.`,
      groupIds: node.agentStep.groupIds,
    })
    const parentExecution = await context.runtime.storage.executions.getById({
      projectId: context.runtime.projectId,
      id: context.runtime.sixb.execution.id,
    })
    if (!parentExecution) {
      throw createSixbError(
        "internal.unexpected",
        `[SixbWorkflowWorker] Workflow run '${context.job.id}' references missing execution '${context.runtime.sixb.execution.id}'.`,
        {
          details: {
            agentStepId: node.agentStep.id,
            workflowId: context.workflow.id,
            workflowRunId: context.job.id,
            nodeId: node.id,
            nodeRunId: nodeRun.id,
            executionId: context.runtime.sixb.execution.id,
          },
        }
      )
    }
    const agentExecution = createAgentExecutionRecord({
      id: `exec_${randomUUID()}`,
      parent: parentExecution,
      actorId: actorId,
      runId: nodeRun.id,
      principal: identity.principal,
    })
    const waitingAt = new Date()
    const parked = await context.runtime.storage.transaction(async (tx) => {
      const workflowRuns = tx.workflowRuns
      if (!workflowRuns) {
        throw createSixbError(
          "internal.unexpected",
          `[SixbWorkflowWorker] Workflow '${context.workflow.id}' agent node '${node.id}' requires storage.workflowRuns.`,
          {
            details: {
              agentStepId: node.agentStep.id,
              workflowId: context.workflow.id,
              workflowRunId: context.job.id,
              nodeId: node.id,
              nodeRunId: nodeRun.id,
            },
          }
        )
      }
      await tx.executions.create(agentExecution)
      const agentNodeRun = await workflowRuns.agentNodes.create({
        projectId: context.runtime.projectId,
        nodeRunId: nodeRun.id,
        executionId: agentExecution.id,
        actorId: actorId,
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
      return { agentExecution: agentNodeRun, nodeRun: waitingNode, run: waitingRun }
    })

    context.markSideEffectBoundaryPassed()
    try {
      await context.runtime.queues.agents.enqueue({
        projectId: context.runtime.projectId,
        jobs: [
          {
            id: workflowAgentNodeQueueJobId(nodeRun.id),
            type: "agent.workflow-node.requested",
            payload: { nodeRunId: nodeRun.id },
          },
        ],
      })
    } catch (error) {
      console.error(
        `[SixbWorkflowWorker] Could not dispatch agent workflow node '${nodeRun.id}'; the agent worker will retry.`,
        error
      )
    }

    return { status: "waiting", ...parked, waitingAt }
  },
}
