import {
  AuthorizationError,
  assertAuthorized,
  assertCanApplyActionOn,
  assertPrivileged,
  canViewActionRun,
  hasDelegatedRuntimeAuthority,
} from "../authorization"
import {
  assertRuntimeAuthorizationCanCrossDurableBoundary,
  resolveExecutionScopeAuthorization,
  resolveRuntimeAuthorizationForProject,
} from "../execution/authorization"
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
import { assertVisibleJsonWithinLimit } from "../storage/objects/execution-limits"
import { actionRunBelongsToShareGrant, canDelegationAccessActionRun } from "./run-authorization"
import { dispatchActionRun } from "./run-dispatch"
import { createActionRunId } from "./run-id"
import type { ActionDefinition, ActionSubject } from "./types"
import {
  isExactObjectActionTarget,
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
  const request = snapshotActionRequest(input)
  resolveExecutionScopeAuthorization(runtime.projectId, {
    execution,
    authorization: runtime.runtimeAuthorization,
  })
  assertAuthorized(runtime, { kind: "action.apply", actionId: request.actionId })
  requireActionRunStorage(runtime)
  const action = getActionDefinition(runtime, request.actionId)
  const actionId = action.id
  const rawParams = request.params
  const subject = request.subject

  validateActionSubject(action, subject)

  if (subject.kind === "object") {
    if (
      hasDelegatedRuntimeAuthority(runtime) &&
      !isExactObjectActionTarget(action, subject.objectTypeId)
    ) {
      throw new AuthorizationError(
        `apply:action:${actionId}:${subject.objectTypeId}:${subject.primaryId}`,
        `[Sixb] Delegated authority cannot apply action '${actionId}' to '${subject.objectTypeId}:${subject.primaryId}'.`
      )
    }
    assertCanApplyActionOn(runtime, actionId, subject)
    if (hasDelegatedRuntimeAuthority(runtime)) {
      const visible = await runtime.objectReader.getByPrimaryId({
        objectTypeId: subject.objectTypeId,
        primaryId: subject.primaryId,
      })
      if (!visible) {
        throw new AuthorizationError(
          `apply:action:${actionId}:${subject.objectTypeId}:${subject.primaryId}`,
          `[Sixb] Delegated authority cannot apply action '${actionId}' to '${subject.objectTypeId}:${subject.primaryId}'.`
        )
      }
    }
  } else if (hasDelegatedRuntimeAuthority(runtime)) {
    // V1 delegations never authorize global Actions.
    assertPrivileged(runtime, `action.apply:${actionId}:global`)
  }

  let pathPrefix = action.id
  let objectType: ObjectTypeWithPropertyTokens | null = null

  if (isObjectActionDefinition(action)) {
    objectType = resolveObjectActionSubject({ runtime, action, subject })
    pathPrefix = `${objectType.id}.${action.id}`
  }

  const actionParams = normalizeActionParams(runtime, action.params, rawParams, pathPrefix)

  // This must precede dispatch so unsupported delegation kinds cannot inspect run idempotency.
  assertRuntimeAuthorizationCanCrossDurableBoundary(runtime.runtimeAuthorization)
  const authority = resolveRuntimeAuthorizationForProject(runtime)

  return dispatchActionRun({
    errorReporterHost: runtime,
    projectId: runtime.projectId,
    storage: runtime.storage,
    queue: runtime.queues.actions,
    events: runtime.events,
    actionId,
    subject,
    params: actionParams,
    runId: request.runId,
    ...(authority.type === "delegated"
      ? {
          assertCanReuseExisting: async (
            storage: SixbRuntimeContext["storage"],
            existing: ActionRunRecord
          ) => {
            if (
              authority.ref.kind !== "share" ||
              !(await actionRunBelongsToShareGrant({
                storage,
                projectId: runtime.projectId,
                run: existing,
                grantId: authority.ref.id,
              }))
            ) {
              throw new AuthorizationError(
                `apply:action:${actionId}`,
                "[Sixb] Delegated authority cannot reuse this Action run."
              )
            }
          },
        }
      : {}),
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

function snapshotActionRequest(input: RequestActionInput): {
  readonly actionId: string
  readonly subject: ActionSubject
  readonly params: Record<string, unknown>
  readonly runId?: string
} {
  const actionId = input.actionId
  const subject = input.subject
  const params = input.params
  const runId = input.runId
  return structuredClone({
    actionId,
    subject: subject ?? { kind: "none" },
    params: params ?? {},
    ...(runId === undefined ? {} : { runId }),
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
  // Keep unsupported delegation kinds ahead of storage and broker dependencies.
  assertRuntimeAuthorizationCanCrossDurableBoundary(runtime.runtimeAuthorization)
  const authority = resolveRuntimeAuthorizationForProject(runtime)
  if (authority.type === "denied") {
    throw new AuthorizationError(
      "runtime:unbound",
      "[Sixb] Protected operations require a registered execution scope for this project."
    )
  }
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

    const releaseSubscription = (release: (() => void) | undefined) => {
      if (!release) return
      try {
        release()
      } catch (error) {
        console.error("[Sixb] Failed to release action run wait subscription:", error)
      }
    }

    const cleanup = () => {
      if (settled) return
      settled = true
      clearTimer(timer)
      clearTimer(pollTimer)
      signal?.removeEventListener("abort", onAbort)
      releaseSubscription(unsubscribe)
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
        const visible =
          record &&
          (authority.type === "unrestricted" ||
            (authority.type === "principal" && canViewActionRun(authority.context, record)) ||
            (authority.type === "delegated" &&
              (await canDelegationAccessActionRun({
                storage: runtime.storage,
                projectId: runtime.projectId,
                authority,
                run: record,
              }))))
        if (visible && isTerminalActionRun(record)) {
          if (authority.type === "delegated") {
            assertVisibleJsonWithinLimit(record, authority.limits)
          }
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
        // Timeout or abort can settle the wait before the asynchronous subscription resolves.
        // `cleanup()` had no handle to release in that case, so release the late handle here.
        if (settled) {
          releaseSubscription(unsubscribeEvents)
          return
        }
        unsubscribe = unsubscribeEvents
        void check()
      })
      .catch((error: unknown) => {
        if (settled) {
          console.error("[Sixb] Action run wait subscription failed after the wait settled:", error)
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
