import type { WorkflowStepOutputs } from "@pario/core"
import { WorkflowWorkerError } from "../errors"
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
    throw new WorkflowWorkerError(
      `[ParioWorkflowWorker] Workflow '${input.workflowId}' node '${input.nodeId}' mapper must be a function.`
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
    throw new WorkflowWorkerError(
      `[ParioWorkflowWorker] Workflow '${input.workflowId}' node '${input.nodeId}' input must be an object.`
    )
  }

  return input.value
}
