import type { ActionRunFailure, WorkflowActionNodeDefinition } from "@sixb/core"
import { ActionRunFailedError, objectService, snapshotWorkflowActionInput } from "@sixb/core"
import { WorkflowWorkerError } from "../errors"
import type { WorkflowNodeExecutor } from "../execution/node-executor"
import { isRecord } from "../normalize"
import { callWorkflowMapper } from "./mapper"

interface ActionMapperResult {
  readonly target: {
    readonly objectTypeId: string
    readonly primaryId: string
  }
  readonly params: Readonly<Record<string, unknown>>
}

export const actionNodeExecutor: WorkflowNodeExecutor<WorkflowActionNodeDefinition> = {
  type: "action",

  prepare({ node, context }) {
    const rawMapperResult = callWorkflowMapper({
      mapper: node.mapper,
      workflowId: context.workflow.id,
      nodeId: node.id,
      workflowInput: context.state.workflowInput,
      steps: context.state.steps,
    })
    const mapperResult = normalizeActionMapperResult({
      workflowId: context.workflow.id,
      nodeId: node.id,
      value: rawMapperResult,
    })
    const inputSnapshot = snapshotWorkflowActionInput({
      target: mapperResult.target,
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
      value: prepared.input,
    })
    const actionRunId = `${context.job.id}:action:${nodeIndex}`

    const run = await objectService.requestActionAndWait(
      context.runtime,
      mapperResult.target.objectTypeId,
      mapperResult.target.primaryId,
      node.action.id,
      { ...mapperResult.params },
      {
        runId: actionRunId,
        signal: context.signal,
        onRequested: () => context.markSideEffectBoundaryPassed(),
      }
    )
    if (run.status !== "succeeded") {
      throw new ActionRunFailedError({
        runId: run.id,
        actionId: run.actionId,
        subject: run.subject,
        error: run.error ?? actionRunStatusFailure(run.status, run.phase),
        finishedAt: (run.finishedAt ?? new Date()).toISOString(),
      })
    }

    return {}
  },
}

function actionRunStatusFailure(
  status: "queued" | "running" | "failed" | "cancelled",
  phase: ActionRunFailure["phase"]
): ActionRunFailure {
  return {
    message: `Action run finished with status '${status}'.`,
    phase,
  }
}

function normalizeActionMapperResult(input: {
  readonly workflowId: string
  readonly nodeId: string
  readonly value: unknown
}): ActionMapperResult {
  if (!isRecord(input.value)) {
    throw new WorkflowWorkerError(
      `[SixbWorkflowWorker] Workflow '${input.workflowId}' action node '${input.nodeId}' mapper must return an object.`
    )
  }

  const { target, params } = input.value
  if (!isObjectRef(target)) {
    throw new WorkflowWorkerError(
      `[SixbWorkflowWorker] Workflow '${input.workflowId}' action node '${input.nodeId}' mapper must return a valid target object ref.`
    )
  }

  if (!isRecord(params)) {
    throw new WorkflowWorkerError(
      `[SixbWorkflowWorker] Workflow '${input.workflowId}' action node '${input.nodeId}' mapper must return params as an object.`
    )
  }

  return {
    target,
    params,
  }
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
