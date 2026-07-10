import type { WorkflowStepNodeDefinition } from "@sixb/core"
import {
  snapshotWorkflowStepInput,
  snapshotWorkflowStepOutput,
  validateWorkflowStepInput,
  validateWorkflowStepOutput,
} from "@sixb/core"
import type { WorkflowNodeExecutor } from "../execution/node-executor"
import { throwIfAborted } from "../normalize"
import { callWorkflowMapper, requireRecordInput } from "./mapper"

export const stepNodeExecutor: WorkflowNodeExecutor<WorkflowStepNodeDefinition> = {
  type: "step",

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
    const stepInput = validateWorkflowStepInput({
      workflowId: context.workflow.id,
      step: node.step,
      value: nodeInput,
      valueTypesById: context.valueTypesById,
    })
    const inputSnapshot = snapshotWorkflowStepInput({
      workflowId: context.workflow.id,
      step: node.step,
      value: stepInput,
      valueTypesById: context.valueTypesById,
    })

    return {
      input: stepInput,
      inputSnapshot,
    }
  },

  async execute({ node, prepared, context }) {
    const stepInput = requireRecordInput({
      value: prepared.input,
      workflowId: context.workflow.id,
      nodeId: node.id,
    })

    context.markSideEffectBoundaryPassed()
    const rawOutput = await node.step.handler({
      input: stepInput,
      sixb: context.runtime.sixb,
      logger: context.logSession.withContext({ stepId: node.step.id }),
    })
    throwIfAborted(context.signal)

    const validatedOutput = validateWorkflowStepOutput({
      workflowId: context.workflow.id,
      step: node.step,
      value: rawOutput,
      valueTypesById: context.valueTypesById,
    })
    const outputSnapshot = snapshotWorkflowStepOutput({
      workflowId: context.workflow.id,
      step: node.step,
      value: validatedOutput,
      valueTypesById: context.valueTypesById,
    })
    const output: Record<string, unknown> = { ...validatedOutput }

    return {
      outputSnapshot,
      statePatch: {
        current: output,
        steps: {
          [node.key]: output,
        },
      },
    }
  },
}
