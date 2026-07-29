import { assertAuthorized } from "../authorization"
import { reportRunFailure } from "../error-reporting/capability"
import { ActionRunTimeoutError } from "../objects/action/errors"
import { OntologyValidationError } from "../ontology/errors"
import type { ObjectTypeWithPropertyTokens } from "../ontology/tokens"
import type { SixbRuntimeContext } from "../runtime/types"
import {
  ActionRunError,
  type ActionRunParams,
  type ActionRunRecord,
  type ActionRunStorage,
  actionRunParamsEqual,
  actionSubjectsEqual,
  isTerminalActionRun,
} from "../storage"
import { createActionRunId, createActionRunIdempotencyKey } from "./run-id"
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
  input: RequestActionInput
): Promise<RequestActionResult> {
  const actionRuns = requireActionRunStorage(runtime)
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

  const runId = createActionRunId(input.runId)
  const existing = await actionRuns.getById({ projectId: runtime.projectId, id: runId })
  if (existing) {
    assertExistingRunMatchesRequest(existing, {
      actionId,
      subject,
      params: actionParams,
    })
    if (isRetryableEnqueueFailure(existing)) {
      const queuedAt = new Date()
      await actionRuns.queue({
        projectId: runtime.projectId,
        id: runId,
        actionId,
        subject,
        params: actionParams,
        idempotencyKey: existing.idempotencyKey,
        queuedAt,
      })
      return enqueueActionRunJob(runtime, {
        actionRuns,
        actionId,
        subject,
        params: actionParams,
        runId,
        queuedAt,
        created: false,
      })
    }
    return {
      runId,
      queuedAt: existing.queuedAt.toISOString(),
      created: false,
    }
  }

  const queuedAt = new Date()
  const idempotencyKey = createActionRunIdempotencyKey(runtime.projectId, runId)

  await actionRuns.queue({
    projectId: runtime.projectId,
    id: runId,
    actionId,
    subject,
    params: actionParams,
    idempotencyKey,
    queuedAt,
  })

  return enqueueActionRunJob(runtime, {
    actionRuns,
    actionId,
    subject,
    params: actionParams,
    runId,
    queuedAt,
    created: true,
  })
}

async function enqueueActionRunJob(
  runtime: SixbRuntimeContext,
  params: {
    readonly actionRuns: ActionRunStorage
    readonly actionId: string
    readonly subject: ActionSubject
    readonly params: ActionRunParams
    readonly runId: string
    readonly queuedAt: Date
    readonly created: boolean
  }
): Promise<RequestActionResult> {
  let jobId: string | undefined
  try {
    const [job] = await runtime.queues.actions.enqueue({
      projectId: runtime.projectId,
      jobs: [
        {
          type: "action.run.requested",
          payload: {
            actionId: params.actionId,
            runId: params.runId,
          },
        },
      ],
    })
    jobId = job?.id
  } catch (error) {
    const failed = await params.actionRuns.finish({
      projectId: runtime.projectId,
      id: params.runId,
      status: "failed",
      phase: "enqueue",
      error: toActionRunFailure(error, "enqueue"),
    })
    reportRunFailure(runtime, error, {
      projectId: runtime.projectId,
      occurredAt: failed.finishedAt,
      run: {
        kind: "action",
        runId: params.runId,
        actionId: params.actionId,
      },
    })
    throw error
  }

  // The run is persisted and the job is queued, so the request has succeeded and the caller must not
  // be told otherwise. `emit` keeps that promise and still escalates the lost trigger edge.
  await runtime.events.emit(
    {
      events: [
        {
          type: "action.requested",
          payload: {
            actionId: params.actionId,
            subject: params.subject,
            params: params.params,
            runId: params.runId,
          },
        },
      ],
    },
    { source: "Sixb" }
  )

  return {
    runId: params.runId,
    queuedAt: params.queuedAt.toISOString(),
    ...(jobId ? { jobId } : {}),
    created: params.created,
  }
}

export async function requestActionAndWait(
  runtime: SixbRuntimeContext,
  input: RequestActionAndWaitInput
): Promise<ActionRunRecord> {
  const runId = createActionRunId(input.runId)

  await requestAction(runtime, {
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
        unsubscribe = unsubscribeEvents
        void check()
      })
      .catch(rejectWith)
  })
}

function requireActionRunStorage(runtime: SixbRuntimeContext): ActionRunStorage {
  const actionRuns = runtime.storage.actionRuns
  if (!actionRuns) {
    throw new ActionRunError("[Sixb] Action run storage is not configured.")
  }
  return actionRuns
}

function assertExistingRunMatchesRequest(
  existing: ActionRunRecord,
  request: {
    readonly actionId: string
    readonly subject: ActionSubject
    readonly params: ActionRunParams
  }
): void {
  const matches =
    existing.actionId === request.actionId &&
    actionSubjectsEqual(existing.subject, request.subject) &&
    actionRunParamsEqual(existing.params, request.params)

  if (!matches) {
    throw new ActionRunError(
      `[Sixb] Action run '${existing.id}' already exists with a different request payload.`
    )
  }
}

function isRetryableEnqueueFailure(record: ActionRunRecord): boolean {
  return record.status === "failed" && record.phase === "enqueue"
}

function toActionRunFailure(
  error: unknown,
  phase: "enqueue"
): { name?: string; message: string; phase: "enqueue" } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      phase,
    }
  }
  return {
    message: String(error),
    phase,
  }
}
