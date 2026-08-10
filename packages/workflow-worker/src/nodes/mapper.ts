import type { WorkflowStepOutputs } from "@sixb/core"
import { createSixbError } from "@sixb/core/internal/errors"
import { isRecord } from "../normalize"

type RuntimeWorkflowMapper = (context: {
  readonly input: Readonly<Record<string, unknown>>
  readonly steps: WorkflowStepOutputs
}) => unknown

export function callWorkflowMapper(input: {
  readonly mapper: unknown
  readonly workflowId: string
  readonly workflowRunId: string
  readonly nodeId: string
  readonly workflowInput: Readonly<Record<string, unknown>>
  readonly steps: WorkflowStepOutputs
}): unknown {
  if (typeof input.mapper !== "function") {
    throw createSixbError(
      "internal.unexpected",
      `[SixbWorkflowWorker] Workflow '${input.workflowId}' node '${input.nodeId}' mapper must be a function.`,
      { details: workflowNodeErrorDetails(input) }
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
  readonly workflowRunId: string
  readonly nodeId: string
  readonly nodeRunId?: string
}): Readonly<Record<string, unknown>> {
  if (!isRecord(input.value)) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbWorkflowWorker] Workflow '${input.workflowId}' node '${input.nodeId}' input must be an object.`,
      { details: workflowNodeErrorDetails(input) }
    )
  }

  return input.value
}

function workflowNodeErrorDetails(input: {
  readonly workflowId: string
  readonly workflowRunId: string
  readonly nodeId: string
  readonly nodeRunId?: string
}): Readonly<Record<string, string>> {
  return {
    workflowId: input.workflowId,
    workflowRunId: input.workflowRunId,
    nodeId: input.nodeId,
    ...(input.nodeRunId ? { nodeRunId: input.nodeRunId } : {}),
  }
}
