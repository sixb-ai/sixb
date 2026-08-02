import type { ActionSubject } from "@sixb/core"
import { ActionRunFailedError, isObjectActionDefinition } from "@sixb/core"
import type { WorkflowActionNodeDefinition } from "@sixb/core/internal/workflows"
import { snapshotWorkflowActionInput } from "@sixb/core/internal/workflows"
import type { ActionRunFailure } from "@sixb/core/storage"
import { WorkflowWorkerError } from "../errors"
import type { WorkflowNodeExecutor } from "../execution/node-executor"
import { isRecord } from "../normalize"
import { callWorkflowMapper } from "./mapper"

interface ActionMapperResult {
  readonly subject?: ActionSubject
  readonly params: Readonly<Record<string, unknown>>
}

export const actionNodeExecutor: WorkflowNodeExecutor<WorkflowActionNodeDefinition> = {
  type: "action",

  prepare({ node, context }) {
    const rawMapperResult =
      node.mapper === undefined
        ? context.state.current
        : callWorkflowMapper({
            mapper: node.mapper,
            workflowId: context.workflow.id,
            nodeId: node.id,
            workflowInput: context.state.workflowInput,
            steps: context.state.steps,
          })
    const mapperResult = normalizeActionMapperResult({
      workflowId: context.workflow.id,
      nodeId: node.id,
      action: node.action,
      value: rawMapperResult,
      mode: node.mapper === undefined ? "direct" : "mapped",
    })
    const inputSnapshot = snapshotWorkflowActionInput({
      subject: mapperResult.subject,
      params: mapperResult.params,
    })

    return {
      input: mapperResult,
      inputSnapshot,
    }
  },

  async execute({ node, nodeIndex, prepared, context }) {
    const mapperResult = normalizeActionMapperResult({
      workflowId: context.workflow.id,
      nodeId: node.id,
      action: node.action,
      value: prepared.input,
      mode: "mapped",
    })
    const actionRunId = `${context.job.id}:action:${nodeIndex}`

    const run = await context.runtime.sixb.actions.requestAndWait({
      actionId: node.action.id,
      subject: mapperResult.subject,
      params: { ...mapperResult.params },
      runId: actionRunId,
      signal: context.signal,
      onRequested: () => context.markSideEffectBoundaryPassed(),
    })
    if (run.status !== "succeeded") {
      throw new ActionRunFailedError({
        runId: run.id,
        actionId: run.actionId,
        subject: run.subject,
        error: run.error ?? actionRunStatusFailure(run.status, run.phase),
        finishedAt: (run.finishedAt ?? new Date()).toISOString(),
      })
    }

    return {
      outputSnapshot: { actionRunId },
    }
  },
}

function actionRunStatusFailure(
  status: "queued" | "running" | "failed" | "cancelled",
  phase: ActionRunFailure["phase"]
): ActionRunFailure {
  return {
    code: "action.failed",
    message: `Action run finished with status '${status}'.`,
    phase,
  }
}

function normalizeActionMapperResult(input: {
  readonly workflowId: string
  readonly nodeId: string
  readonly action: WorkflowActionNodeDefinition["action"]
  readonly value: unknown
  readonly mode: "direct" | "mapped"
}): ActionMapperResult {
  if (!isRecord(input.value)) {
    throw new WorkflowWorkerError(
      `[SixbWorkflowWorker] Workflow '${input.workflowId}' action node '${input.nodeId}' input must be an object.`
    )
  }

  const value = input.value

  if (input.mode === "direct") {
    return normalizeDirectActionInput({ ...input, value })
  }

  return normalizeMappedActionInput({ ...input, value })
}

function normalizeMappedActionInput(input: {
  readonly workflowId: string
  readonly nodeId: string
  readonly action: WorkflowActionNodeDefinition["action"]
  readonly value: Readonly<Record<string, unknown>>
}): ActionMapperResult {
  const { subject, params } = input.value

  if (!isRecord(params)) {
    throw new WorkflowWorkerError(
      `[SixbWorkflowWorker] Workflow '${input.workflowId}' action node '${input.nodeId}' mapper must return params as an object.`
    )
  }

  if (isObjectActionDefinition(input.action)) {
    return {
      subject: normalizeObjectActionSubject({
        workflowId: input.workflowId,
        nodeId: input.nodeId,
        value: subject,
      }),
      params,
    }
  }

  if (Object.hasOwn(input.value, "subject")) {
    throw new WorkflowWorkerError(
      `[SixbWorkflowWorker] Workflow '${input.workflowId}' action node '${input.nodeId}' mapper must not return subject for a global action.`
    )
  }

  return {
    params,
  }
}

function normalizeDirectActionInput(input: {
  readonly workflowId: string
  readonly nodeId: string
  readonly action: WorkflowActionNodeDefinition["action"]
  readonly value: Readonly<Record<string, unknown>>
}): ActionMapperResult {
  if (isObjectActionDefinition(input.action)) {
    if (!Object.hasOwn(input.value, "subject")) {
      throw new WorkflowWorkerError(
        `[SixbWorkflowWorker] Workflow '${input.workflowId}' action node '${input.nodeId}' direct input must include subject for an object action.`
      )
    }

    return {
      subject: normalizeObjectActionSubject({
        workflowId: input.workflowId,
        nodeId: input.nodeId,
        value: input.value.subject,
      }),
      params: pickActionParams(input.action, input.value),
    }
  }

  if (Object.hasOwn(input.value, "subject")) {
    throw new WorkflowWorkerError(
      `[SixbWorkflowWorker] Workflow '${input.workflowId}' action node '${input.nodeId}' direct input must not include subject for a global action.`
    )
  }

  return {
    params: pickActionParams(input.action, input.value),
  }
}

function pickActionParams(
  action: WorkflowActionNodeDefinition["action"],
  value: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  for (const paramId of Object.keys(action.params)) {
    if (Object.hasOwn(value, paramId)) {
      params[paramId] = value[paramId]
    }
  }
  return params
}

function normalizeObjectActionSubject(input: {
  readonly workflowId: string
  readonly nodeId: string
  readonly value: unknown
}): ActionSubject {
  if (isActionObjectSubject(input.value)) {
    return input.value
  }

  if (!isObjectRef(input.value)) {
    throw new WorkflowWorkerError(
      `[SixbWorkflowWorker] Workflow '${input.workflowId}' action node '${input.nodeId}' mapper must return a valid subject object ref.`
    )
  }

  return {
    kind: "object",
    objectTypeId: input.value.objectTypeId,
    primaryId: input.value.primaryId,
  }
}

function isActionObjectSubject(
  value: unknown
): value is Extract<ActionSubject, { kind: "object" }> {
  return isRecord(value) && value.kind === "object" && isObjectRef(value)
}

function isObjectRef(value: unknown): value is { objectTypeId: string; primaryId: string } {
  return (
    isRecord(value) &&
    typeof value.objectTypeId === "string" &&
    value.objectTypeId.trim().length > 0 &&
    typeof value.primaryId === "string" &&
    value.primaryId.trim().length > 0
  )
}
