import type { WorkflowInterventionNodeDefinition } from "@pario/core"
import {
  snapshotWorkflowInterventionDefaultResponse,
  snapshotWorkflowInterventionInput,
  validateWorkflowInterventionDefaultResponse,
  validateWorkflowInterventionInput,
} from "@pario/core"
import { WorkflowWorkerError } from "../errors"
import type { WorkflowNodeExecutor } from "../execution/node-executor"
import { callWorkflowMapper, requireRecordInput } from "./mapper"

export const interventionNodeExecutor: WorkflowNodeExecutor<WorkflowInterventionNodeDefinition> = {
  type: "intervention",

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
    const interventionInput = validateWorkflowInterventionInput({
      workflowId: context.workflow.id,
      intervention: node.intervention,
      value: nodeInput,
      valueTypesById: context.valueTypesById,
    })
    const inputSnapshot = snapshotWorkflowInterventionInput({
      workflowId: context.workflow.id,
      intervention: node.intervention,
      value: interventionInput,
      valueTypesById: context.valueTypesById,
    })

    return {
      input: interventionInput,
      inputSnapshot,
    }
  },

  async execute({ node, nodeIndex, nodeRun, prepared, context }) {
    const interventionStorage = context.runtime.storage.workflowInterventions
    if (!interventionStorage) {
      throw new WorkflowWorkerError(
        "[ParioWorkflowWorker] Workflow intervention nodes require storage.workflowInterventions."
      )
    }

    const interventionInput = requireRecordInput({
      value: prepared.input,
      workflowId: context.workflow.id,
      nodeId: node.id,
    })
    const rawDefaultResponse =
      (await node.intervention.defaults?.({
        input: interventionInput,
        workflowInput: context.state.workflowInput,
        steps: context.state.steps,
      })) ?? {}
    const defaultResponse = validateWorkflowInterventionDefaultResponse({
      workflowId: context.workflow.id,
      intervention: node.intervention,
      value: rawDefaultResponse,
      valueTypesById: context.valueTypesById,
    })
    const defaultResponseSnapshot = snapshotWorkflowInterventionDefaultResponse({
      workflowId: context.workflow.id,
      intervention: node.intervention,
      value: defaultResponse,
      valueTypesById: context.valueTypesById,
    })
    const requestedAt = new Date()

    context.markSideEffectBoundaryPassed()
    const pendingIntervention = await interventionStorage.create({
      id: `${context.job.id}:intervention:${nodeIndex}`,
      projectId: context.runtime.projectId,
      workflowId: context.workflow.id,
      workflowRunId: context.job.id,
      nodeRunId: nodeRun.id,
      nodeIndex,
      nodeId: node.id,
      nodeKey: node.key,
      interventionId: node.intervention.id,
      input: prepared.inputSnapshot,
      defaultResponse: defaultResponseSnapshot,
      requestedAt,
    })

    return {
      waitForIntervention: pendingIntervention,
    }
  },
}
