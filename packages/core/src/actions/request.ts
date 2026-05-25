import { randomUUID } from "node:crypto"
import type { StoredActionCompletedEvent, StoredActionFailedEvent } from "../events"
import {
  ActionRunFailedError,
  ActionRunTimeoutError,
  ActionValidationError,
} from "../objects/action/errors"
import { requireObject } from "../objects/helpers"
import { OntologyValidationError } from "../ontology/errors"
import type { ObjectTypeWithPropertyTokens } from "../ontology/tokens"
import type { ParioRuntimeContext } from "../runtime/types"
import type {
  ActionDefinition,
  ActionSubject,
  ActionTargetObject,
  ObjectActionDefinition,
} from "./types"
import {
  isGlobalActionDefinition,
  isObjectActionDefinition,
  resolveObjectActionSubject,
  validateActionParams,
  validateActionSubject,
} from "./validation"

export interface RequestActionOptions {
  readonly runId?: string
  readonly signal?: AbortSignal
}

export interface RequestActionAndWaitOptions extends RequestActionOptions {
  readonly timeoutMs?: number
  readonly onRequested?: (runId: string) => void | Promise<void>
}

export interface RequestActionInput {
  readonly actionId: string
  readonly subject?: ActionSubject
  readonly params?: Record<string, unknown>
  readonly runId?: string
  readonly signal?: AbortSignal
}

export interface RequestActionAndWaitInput extends RequestActionInput {
  readonly timeoutMs?: number
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

function clearTimer(timer: ReturnType<typeof setTimeout> | undefined): void {
  if (timer) {
    clearTimeout(timer)
  }
}

function getActionDefinition(runtime: ParioRuntimeContext, actionId: string): ActionDefinition {
  const action = runtime.actionRegistry.getById(actionId)
  if (!action) {
    throw new OntologyValidationError(`Unknown action '${actionId}'`)
  }
  return action
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

async function loadActionTarget(params: {
  readonly runtime: ParioRuntimeContext
  readonly action: ObjectActionDefinition
  readonly objectType: ObjectTypeWithPropertyTokens
  readonly subject: Extract<ActionSubject, { kind: "object" }>
}): Promise<ActionTargetObject> {
  const { runtime, action, objectType, subject } = params
  const targetRow = await requireObject(
    runtime.storage,
    runtime.projectId,
    objectType.id,
    subject.primaryId,
    "Object not found for action request"
  )

  return toActionTargetObject(targetRow, action.target.id)
}

function isTerminalActionEvent(
  event: StoredActionCompletedEvent | StoredActionFailedEvent,
  runId: string
): boolean {
  return event.payload.runId === runId
}

export async function requestAction(
  runtime: ParioRuntimeContext,
  input: RequestActionInput
): Promise<{ runId: string }> {
  const action = getActionDefinition(runtime, input.actionId)
  const actionId = action.id
  const actionParams: Record<string, unknown> = input.params ?? {}
  const subject: ActionSubject = input.subject ?? { kind: "none" }
  const signal = input.signal ?? new AbortController().signal

  validateActionSubject(action, subject)

  let pathPrefix = action.id
  let objectType: ObjectTypeWithPropertyTokens | null = null

  if (isObjectActionDefinition(action)) {
    objectType = resolveObjectActionSubject({ runtime, action, subject })
    pathPrefix = `${objectType.id}.${action.id}`
  }

  validateActionParams(runtime, action, actionParams, pathPrefix)

  if (isGlobalActionDefinition(action)) {
    for (const validator of action.validators) {
      const result = await validator({ params: actionParams, signal })

      if (result && "error" in result) {
        throw new ActionValidationError(result.error, { actionId, subject })
      }
    }
  } else if (objectType !== null && subject.kind === "object") {
    const target = await loadActionTarget({ runtime, action, objectType, subject })
    for (const validator of action.validators) {
      const result = await validator({ params: actionParams, target, signal })

      if (result && "error" in result) {
        throw new ActionValidationError(result.error, { actionId, subject })
      }
    }
  }

  const runId = createActionRunId(input.runId)

  await runtime.events.append({
    events: [
      {
        type: "action.requested",
        payload: {
          actionId,
          subject,
          params: actionParams,
          runId,
        },
      },
    ],
  })

  return { runId }
}

export async function requestActionAndWait(
  runtime: ParioRuntimeContext,
  input: RequestActionAndWaitInput
): Promise<{ runId: string }> {
  const runId = createActionRunId(input.runId)
  const timeoutMs = input.timeoutMs ?? DEFAULT_ACTION_WAIT_TIMEOUT_MS
  const signal = input.signal

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

  unsubscribe = await runtime.events.subscribe(
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
    await requestAction(runtime, {
      ...input,
      runId,
    })
    await input.onRequested?.(runId)
  } catch (error) {
    cleanup()
    throw error
  }

  return terminal
}
