import { randomUUID } from "node:crypto"
import type { SecurityContext } from "../auth"
import type { EventActor } from "../events"
import { ActionRunTimeoutError, ActionValidationError } from "../objects/action/errors"
import { requireObject } from "../objects/helpers"
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
import type {
  ActionDefinition,
  ActionSubject,
  ActionTargetObject,
  ObjectActionDefinition,
} from "./types"
import {
  isGlobalActionDefinition,
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
  readonly securityContext?: SecurityContext
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
  readonly securityContext?: SecurityContext
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

function createActionRunId(runId: string | undefined): string {
  if (runId !== undefined) {
    if (!runId.trim()) {
      throw new OntologyValidationError("[Sixb] Action run id must not be empty")
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

function getActionDefinition(runtime: SixbRuntimeContext, actionId: string): ActionDefinition {
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
  readonly runtime: SixbRuntimeContext
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

export async function requestAction(
  runtime: SixbRuntimeContext,
  input: RequestActionInput
): Promise<RequestActionResult> {
  const actionRuns = requireActionRunStorage(runtime)
  const action = getActionDefinition(runtime, input.actionId)
  const actionId = action.id
  const rawParams: Record<string, unknown> = input.params ?? {}
  const subject: ActionSubject = input.subject ?? { kind: "none" }
  const signal = input.signal ?? new AbortController().signal

  validateActionSubject(action, subject)

  let pathPrefix = action.id
  let objectType: ObjectTypeWithPropertyTokens | null = null

  if (isObjectActionDefinition(action)) {
    objectType = resolveObjectActionSubject({ runtime, action, subject })
    pathPrefix = `${objectType.id}.${action.id}`
  }

  const actionParams = normalizeActionParams(runtime, action.params, rawParams, pathPrefix)

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
        securityContext: existing.securityContext,
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
        securityContext: input.securityContext,
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
    securityContext: input.securityContext,
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
    securityContext: input.securityContext,
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
    readonly securityContext?: SecurityContext
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
    await params.actionRuns.finish({
      projectId: runtime.projectId,
      id: params.runId,
      status: "failed",
      phase: "enqueue",
      error: toActionRunFailure(error, "enqueue"),
    })
    throw error
  }

  try {
    await runtime.events.append({
      actor: params.securityContext ? toEventActor(params.securityContext) : undefined,
      correlationId: params.securityContext?.correlationId,
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
    })
  } catch (error) {
    console.error("[Sixb] Failed to append action.requested observation event:", error)
  }

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

function createActionRunIdempotencyKey(projectId: string, runId: string): string {
  return `action:${projectId}:${runId}`
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

function toEventActor(securityContext: SecurityContext): EventActor {
  if (securityContext.principal.type === "serviceAccount") {
    return { type: "service", id: securityContext.principal.id }
  }
  return securityContext.principal
}
