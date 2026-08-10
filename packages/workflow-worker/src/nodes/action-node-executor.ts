import type { ActionSubject } from "@sixb/core"
import { ActionRunFailedError, isObjectActionDefinition } from "@sixb/core"
import { parseActionRunFailure } from "@sixb/core/internal/action-run-storage"
import { createSixbError, toSixbFailure } from "@sixb/core/internal/errors"
import type { WorkflowActionNodeDefinition } from "@sixb/core/internal/workflows"
import { snapshotWorkflowActionInput } from "@sixb/core/internal/workflows"
import {
  ACTION_RUN_FAILURE_CODES,
  type ActionRunFailure,
  type ActionRunPhase,
} from "@sixb/core/storage"
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
            workflowRunId: context.job.id,
            nodeId: node.id,
            workflowInput: context.state.workflowInput,
            steps: context.state.steps,
          })
    const mapperResult = normalizeActionMapperResult({
      workflowId: context.workflow.id,
      workflowRunId: context.job.id,
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

  async execute({ node, nodeIndex, nodeRun, prepared, context }) {
    const mapperResult = normalizeActionMapperResult({
      workflowId: context.workflow.id,
      workflowRunId: context.job.id,
      nodeId: node.id,
      nodeRunId: nodeRun.id,
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
      const finishedAt = run.finishedAt ?? new Date()
      throw new ActionRunFailedError({
        runId: run.id,
        actionId: run.actionId,
        subject: run.subject,
        error:
          run.error ??
          actionRunStatusFailure({
            status: run.status,
            phase: run.phase,
            actionId: run.actionId,
            runId: run.id,
            at: finishedAt,
          }),
        finishedAt: finishedAt.toISOString(),
      })
    }

    return {
      outputSnapshot: { actionRunId },
    }
  },
}

function actionRunStatusFailure(input: {
  readonly status: "queued" | "running" | "failed" | "cancelled"
  readonly phase?: ActionRunPhase
  readonly actionId: string
  readonly runId: string
  readonly at: Date
}): ActionRunFailure {
  const phase = input.phase ?? (input.status === "cancelled" ? "cancelled" : "validation")
  const error = createSixbError(
    input.status === "cancelled" ? "runtime.cancelled" : "internal.unexpected",
    `Action run finished with status '${input.status}'.`,
    {
      details: {
        actionId: input.actionId,
        runId: input.runId,
        phase,
      },
    }
  )
  return parseActionRunFailure(
    toSixbFailure(error, {
      allowedCodes: ACTION_RUN_FAILURE_CODES,
      at: input.at,
    }),
    phase
  )
}

function normalizeActionMapperResult(input: {
  readonly workflowId: string
  readonly workflowRunId: string
  readonly nodeId: string
  readonly nodeRunId?: string
  readonly action: WorkflowActionNodeDefinition["action"]
  readonly value: unknown
  readonly mode: "direct" | "mapped"
}): ActionMapperResult {
  if (!isRecord(input.value)) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbWorkflowWorker] Workflow '${input.workflowId}' action node '${input.nodeId}' input must be an object.`,
      { details: actionNodeErrorDetails(input) }
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
  readonly workflowRunId: string
  readonly nodeId: string
  readonly nodeRunId?: string
  readonly action: WorkflowActionNodeDefinition["action"]
  readonly value: Readonly<Record<string, unknown>>
}): ActionMapperResult {
  const { subject, params } = input.value

  if (!isRecord(params)) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbWorkflowWorker] Workflow '${input.workflowId}' action node '${input.nodeId}' mapper must return params as an object.`,
      { details: actionNodeErrorDetails(input) }
    )
  }

  if (isObjectActionDefinition(input.action)) {
    return {
      subject: normalizeObjectActionSubject({
        workflowId: input.workflowId,
        workflowRunId: input.workflowRunId,
        nodeId: input.nodeId,
        nodeRunId: input.nodeRunId,
        action: input.action,
        value: subject,
      }),
      params,
    }
  }

  if (Object.hasOwn(input.value, "subject")) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbWorkflowWorker] Workflow '${input.workflowId}' action node '${input.nodeId}' mapper must not return subject for a global action.`,
      { details: actionNodeErrorDetails(input) }
    )
  }

  return {
    params,
  }
}

function normalizeDirectActionInput(input: {
  readonly workflowId: string
  readonly workflowRunId: string
  readonly nodeId: string
  readonly nodeRunId?: string
  readonly action: WorkflowActionNodeDefinition["action"]
  readonly value: Readonly<Record<string, unknown>>
}): ActionMapperResult {
  if (isObjectActionDefinition(input.action)) {
    if (!Object.hasOwn(input.value, "subject")) {
      throw createSixbError(
        "internal.unexpected",
        `[SixbWorkflowWorker] Workflow '${input.workflowId}' action node '${input.nodeId}' direct input must include subject for an object action.`,
        { details: actionNodeErrorDetails(input) }
      )
    }

    return {
      subject: normalizeObjectActionSubject({
        workflowId: input.workflowId,
        workflowRunId: input.workflowRunId,
        nodeId: input.nodeId,
        nodeRunId: input.nodeRunId,
        action: input.action,
        value: input.value.subject,
      }),
      params: pickActionParams(input.action, input.value),
    }
  }

  if (Object.hasOwn(input.value, "subject")) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbWorkflowWorker] Workflow '${input.workflowId}' action node '${input.nodeId}' direct input must not include subject for a global action.`,
      { details: actionNodeErrorDetails(input) }
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
  readonly workflowRunId: string
  readonly nodeId: string
  readonly nodeRunId?: string
  readonly action: WorkflowActionNodeDefinition["action"]
  readonly value: unknown
}): ActionSubject {
  if (isActionObjectSubject(input.value)) {
    return input.value
  }

  if (!isObjectRef(input.value)) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbWorkflowWorker] Workflow '${input.workflowId}' action node '${input.nodeId}' mapper must return a valid subject object ref.`,
      { details: actionNodeErrorDetails(input) }
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

function actionNodeErrorDetails(input: {
  readonly workflowId: string
  readonly workflowRunId: string
  readonly nodeId: string
  readonly nodeRunId?: string
  readonly action: WorkflowActionNodeDefinition["action"]
}): Readonly<Record<string, string>> {
  return {
    actionId: input.action.id,
    workflowId: input.workflowId,
    workflowRunId: input.workflowRunId,
    nodeId: input.nodeId,
    ...(input.nodeRunId ? { nodeRunId: input.nodeRunId } : {}),
  }
}
