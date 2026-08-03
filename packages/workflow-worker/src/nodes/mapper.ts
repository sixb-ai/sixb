import type { WorkflowStepOutputs } from "@sixb/core"
import { SixbError } from "@sixb/core/errors"
import { isRecord } from "../normalize"

type RuntimeWorkflowMapper = (context: {
  readonly input: Readonly<Record<string, unknown>>
  readonly steps: WorkflowStepOutputs
}) => unknown

export function callWorkflowMapper(input: {
  readonly mapper: unknown
  readonly workflowId: string
  readonly nodeId: string
  readonly workflowInput: Readonly<Record<string, unknown>>
  readonly steps: WorkflowStepOutputs
}): unknown {
  if (typeof input.mapper !== "function") {
    throw new SixbError(
      "workflow.failed",
      `[SixbWorkflowWorker] Workflow '${input.workflowId}' node '${input.nodeId}' mapper must be a function.`
    )
  }

  return (input.mapper as RuntimeWorkflowMapper)({
    input: input.workflowInput,
    steps: input.steps,
  })
}

export function requireRecordInput(input: {
  readonly value: unknown
  readonly workflowId: string
  readonly nodeId: string
}): Readonly<Record<string, unknown>> {
  if (!isRecord(input.value)) {
    throw new SixbError(
      "workflow.failed",
      `[SixbWorkflowWorker] Workflow '${input.workflowId}' node '${input.nodeId}' input must be an object.`
    )
  }

  return input.value
}
