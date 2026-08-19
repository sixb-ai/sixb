import { assertAuthorized } from "../authorization"
import {
  createPrimitiveExecutionRecord,
  ensureExecutionRecord,
  executionRecordInputFromRuntime,
} from "../execution/durable"
import type { ExecutionContext } from "../execution/types"
import { ActionRunTimeoutError } from "../objects/action/errors"
import { OntologyValidationError } from "../ontology/errors"
import type { ObjectTypeWithPropertyTokens } from "../ontology/tokens"
import type { SixbRuntimeContext } from "../runtime/types"
import {
  ActionRunError,
  type ActionRunRecord,
  type ActionRunStorage,
  isTerminalActionRun,
} from "../storage"
import { dispatchActionRun } from "./run-dispatch"
import { createActionRunId } from "./run-id"
import type { ActionDefinition, ActionSubject } from "./types"
import {
  isObjectActionDefinition,
  normalizeActionParams,
  resolveObjectActionSubject,
  validateActionSubject,
} from "./validation"

export interface RequestActionResult {
  readonly runId: string
  readonly queuedAt: string
  readonly jobId?: string
  readonly created: boolean
}

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

export interface WaitForActionRunInput {
  readonly runId: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

const DEFAULT_ACTION_WAIT_TIMEOUT_MS = 60_000
const DEFAULT_ACTION_WAIT_POLL_MS = 1_000

function clearTimer(timer: ReturnType<typeof setTimeout> | undefined): void {
  if (timer) {
    clearTimeout(timer)
  }
}

function getActionDefinition(runtime: SixbRuntimeContext, actionId: string): ActionDefinition {
  const action = runtime.actionRegistry.getById(actionId)
  if (!action) {
    throw new OntologyValidationError(`Unknown action '${actionId}'`)
  }
  return action
}

export async function requestAction(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  input: RequestActionInput
): Promise<RequestActionResult> {
  requireActionRunStorage(runtime)
  const action = getActionDefinition(runtime, input.actionId)
  const actionId = action.id
  const rawParams: Record<string, unknown> = input.params ?? {}
  const subject: ActionSubject = input.subject ?? { kind: "none" }

  assertAuthorized(runtime, { kind: "action.apply", actionId })
  if (action.binding.kind === "object") {
    // Object actions also require visibility of the subject's object type.
    assertAuthorized(runtime, { kind: "object.view", objectTypeId: action.binding.objectType.id })
  }

  validateActionSubject(action, subject)

  let pathPrefix = action.id
  let objectType: ObjectTypeWithPropertyTokens | null = null

  if (isObjectActionDefinition(action)) {
    objectType = resolveObjectActionSubject({ runtime, action, subject })
    pathPrefix = `${objectType.id}.${action.id}`
  }

  const actionParams = normalizeActionParams(runtime, action.params, rawParams, pathPrefix)

  return dispatchActionRun({
    errorReporterHost: runtime,
    projectId: runtime.projectId,
    storage: runtime.storage,
    queue: runtime.queues.actions,
    events: runtime.events,
    actionId,
    subject,
    params: actionParams,
    runId: input.runId,
    createExecution: async (executionId, runId) => {
      const caller = await ensureExecutionRecord(
        runtime.storage.executions,
        executionRecordInputFromRuntime({
          execution,
          runtimeAuthorization: runtime.runtimeAuthorization,
        })
      )
      return createPrimitiveExecutionRecord({
        id: executionId,
        primitive: { kind: "action", id: actionId, runId },
        origin: { type: "execution", parent: caller },
      })
    },
  })
}

export async function requestActionAndWait(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  input: RequestActionAndWaitInput
): Promise<ActionRunRecord> {
  const runId = createActionRunId(input.runId)

  await requestAction(runtime, execution, {
    ...input,
    runId,
  })
  await input.onRequested?.(runId)

  return waitForActionRun(runtime, {
    runId,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  })
}

export async function waitForActionRun(
  runtime: SixbRuntimeContext,
  input: WaitForActionRunInput
): Promise<ActionRunRecord> {
  const actionRuns = requireActionRunStorage(runtime)
  const timeoutMs = input.timeoutMs ?? DEFAULT_ACTION_WAIT_TIMEOUT_MS
  const signal = input.signal
  const startedAt = Date.now()

  if (signal?.aborted) {
    throw signal.reason ?? new Error("aborted")
  }

  return new Promise<ActionRunRecord>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    let unsubscribe: (() => void) | undefined
    let settled = false
    let checking = false

    const cleanup = () => {
      if (settled) return
      settled = true
      clearTimer(timer)
      clearTimer(pollTimer)
      unsubscribe?.()
      signal?.removeEventListener("abort", onAbort)
    }

    const rejectWith = (error: unknown) => {
      cleanup()
      reject(error)
    }

    const schedulePoll = () => {
      if (!settled && !pollTimer) {
        pollTimer = setTimeout(() => {
          pollTimer = undefined
          void check()
        }, DEFAULT_ACTION_WAIT_POLL_MS)
      }
    }

    const check = async () => {
      if (settled || checking) {
        return
      }
      checking = true
      try {
        const record = await actionRuns.getById({
          projectId: runtime.projectId,
          id: input.runId,
        })
        if (record && isTerminalActionRun(record)) {
          cleanup()
          resolve(record)
          return
        }
        schedulePoll()
      } catch (error) {
        rejectWith(error)
      } finally {
        checking = false
      }
    }

    const onAbort = () => {
      rejectWith(signal?.reason ?? new Error("aborted"))
    }

    timer = setTimeout(
      () => {
        rejectWith(new ActionRunTimeoutError({ runId: input.runId, timeoutMs }))
      },
      Math.max(0, timeoutMs - (Date.now() - startedAt))
    )

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true })
    }

    runtime.events
      .subscribe({ types: ["action.completed", "action.failed"] }, (events) => {
        if (
          events.some(
            (event) =>
              (event.type === "action.completed" || event.type === "action.failed") &&
              event.payload.runId === input.runId
          )
        ) {
          void check()
        }
      })
      .then((unsubscribeEvents) => {
        // The wait can settle before the subscription resolves, on timeout or on abort.
        // `cleanup()` has run by then and saw no unsubscribe, so releasing it here is the only
        // chance to release it at all.
        if (settled) {
          unsubscribeEvents()
          return
        }
        unsubscribe = unsubscribeEvents
        void check()
      })
      .catch((error: unknown) => {
        // Once the wait has settled both halves of `rejectWith` are inert: `cleanup()` returns
        // early and `reject()` no longer changes the promise. Reporting a failed subscribe, or a
        // release that threw, is all that is left to do with it.
        if (settled) {
          console.error("[Sixb] Action run wait could not release its subscription.", error)
          return
        }
        rejectWith(error)
      })
  })
}

function requireActionRunStorage(runtime: SixbRuntimeContext): ActionRunStorage {
  const actionRuns = runtime.storage.actionRuns
  if (!actionRuns) {
    throw new ActionRunError("[Sixb] Action run storage is not configured.")
  }
  return actionRuns
}
