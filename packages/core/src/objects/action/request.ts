/**
 * Leaf operation: request an action on an object.
 */
import { randomUUID } from "node:crypto"
import type { ActionTargetObject } from "../../actions"
import type { StoredActionCompletedEvent, StoredActionFailedEvent } from "../../events"
import { validateSchemaOrRefValue } from "../../ontology"
import { OntologyValidationError } from "../../ontology/errors"
import type { ResolvedObjectContext } from "../context"
import { requireObject } from "../helpers"
import { ActionRunFailedError, ActionRunTimeoutError, ActionValidationError } from "./errors"

export interface RequestActionOptions {
  readonly runId?: string
}

export interface RequestActionAndWaitOptions extends RequestActionOptions {
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  readonly onRequested?: (runId: string) => void | Promise<void>
}

const DEFAULT_ACTION_WAIT_TIMEOUT_MS = 60_000

function createActionRunId(runId: string | undefined): string {
  if (runId !== undefined) {
    if (!runId.trim()) {
      throw new OntologyValidationError("[Pario] Action run id must not be empty")
    }
    return runId
  }

  return `act_${randomUUID()}`
}

function toActionTargetObject(
  row: Awaited<ReturnType<typeof requireObject>>,
  declaredObjectTypeId: string
): ActionTargetObject {
  return {
    primaryId: row.primaryId,
    objectTypeId: declaredObjectTypeId,
    properties: row.properties,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function clearTimer(timer: ReturnType<typeof setTimeout> | undefined): void {
  if (timer) {
    clearTimeout(timer)
  }
}

function isTerminalActionEvent(
  event: StoredActionCompletedEvent | StoredActionFailedEvent,
  runId: string
): boolean {
  return event.payload.runId === runId
}

export async function requestAction(
  ctx: ResolvedObjectContext,
  params: {
    primaryId: string
    actionId: string
    params?: Record<string, unknown>
    options?: RequestActionOptions
  }
): Promise<{ runId: string }> {
  const { events, storage, projectId, objectType, ontology } = ctx
  const { primaryId, actionId } = params
  const actionParams = params.params ?? {}

  const actionDef = ctx.actionRegistry
    .getActionsForType(objectType)
    .find((action) => action.id === actionId)
  if (!actionDef) {
    throw new OntologyValidationError(
      `Unknown action '${actionId}' on object type '${objectType.id}'`
    )
  }

  const knownParamIds = new Set(Object.keys(actionDef.params))
  for (const paramId of Object.keys(actionParams)) {
    if (!knownParamIds.has(paramId)) {
      throw new OntologyValidationError(
        `Unknown param '${paramId}' for action '${objectType.id}.${actionDef.id}'`
      )
    }
  }

  for (const [paramId, paramDef] of Object.entries(actionDef.params)) {
    if (paramDef.required && actionParams[paramId] === undefined) {
      throw new OntologyValidationError(
        `Missing required param '${paramId}' for action '${objectType.id}.${actionDef.id}'`
      )
    }

    if (actionParams[paramId] !== undefined) {
      validateSchemaOrRefValue(
        paramDef.schema,
        actionParams[paramId],
        `${objectType.id}.${actionDef.id}.${paramId}`,
        ontology.getValueTypesById()
      )
    }
  }

  const targetRow = await requireObject(
    storage,
    projectId,
    objectType.id,
    primaryId,
    "Object not found for action request"
  )
  const target = toActionTargetObject(targetRow, actionDef.target.id)

  for (const validator of actionDef.validators) {
    const result = await validator({
      params: actionParams,
      target,
      signal: new AbortController().signal,
    })
    if (result && "error" in result) {
      throw new ActionValidationError(result.error, { actionId, primaryId })
    }
  }

  const runId = createActionRunId(params.options?.runId)

  await events.append({
    events: [
      {
        type: "action.requested",
        payload: {
          objectTypeId: objectType.id,
          primaryId,
          actionId,
          params: actionParams,
          runId,
        },
      },
    ],
  })

  return { runId }
}

export async function requestActionAndWait(
  ctx: ResolvedObjectContext,
  params: {
    primaryId: string
    actionId: string
    params?: Record<string, unknown>
    options?: RequestActionAndWaitOptions
  }
): Promise<{ runId: string }> {
  const runId = createActionRunId(params.options?.runId)
  const timeoutMs = params.options?.timeoutMs ?? DEFAULT_ACTION_WAIT_TIMEOUT_MS
  const signal = params.options?.signal

  if (signal?.aborted) {
    throw signal.reason ?? new Error("aborted")
  }

  let unsubscribe: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let abortListener: (() => void) | undefined
  let settled = false

  const cleanup = () => {
    if (settled) {
      return
    }
    settled = true
    clearTimer(timer)
    unsubscribe?.()
    if (abortListener && signal) {
      signal.removeEventListener("abort", abortListener)
      abortListener = undefined
    }
  }

  let resolveTerminal!: (value: { runId: string }) => void
  let rejectTerminal!: (reason?: unknown) => void
  const terminal = new Promise<{ runId: string }>((resolve, reject) => {
    resolveTerminal = resolve
    rejectTerminal = reject
  })

  unsubscribe = await ctx.events.subscribe(
    {
      types: ["action.completed", "action.failed"],
    },
    (events) => {
      for (const event of events) {
        if (event.type !== "action.completed" && event.type !== "action.failed") {
          continue
        }
        if (!isTerminalActionEvent(event, runId)) {
          continue
        }

        cleanup()
        if (event.type === "action.completed") {
          resolveTerminal({ runId: event.payload.runId })
        } else {
          rejectTerminal(new ActionRunFailedError(event.payload))
        }
      }
    }
  )

  timer = setTimeout(() => {
    cleanup()
    rejectTerminal(new ActionRunTimeoutError({ runId, timeoutMs }))
  }, timeoutMs)

  if (signal) {
    if (signal.aborted) {
      cleanup()
      rejectTerminal(signal.reason ?? new Error("aborted"))
    } else {
      abortListener = () => {
        cleanup()
        rejectTerminal(signal.reason ?? new Error("aborted"))
      }
      signal.addEventListener("abort", abortListener, { once: true })
    }
  }
  terminal.catch(() => {})

  try {
    await requestAction(ctx, {
      primaryId: params.primaryId,
      actionId: params.actionId,
      params: params.params,
      options: { runId },
    })
    await params.options?.onRequested?.(runId)
  } catch (error) {
    cleanup()
    throw error
  }

  return terminal
}
