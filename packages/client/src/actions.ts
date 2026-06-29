import { events } from "./events-builder"
import type { Client } from "./generated/client"
import { getActionRun, type Options, requestAction } from "./generated/sdk.gen"
import type {
  GetActionRunResponse,
  RequestActionData,
  RequestActionResponse,
} from "./generated/types.gen"

const DEFAULT_ACTION_WAIT_TIMEOUT_MS = 60_000
const DEFAULT_ACTION_WAIT_FALLBACK_POLL_MS = 10_000
const DEFAULT_ACTION_WAIT_DISCONNECTED_POLL_MS = 1_000

export type ActionRunDetail = GetActionRunResponse
export type ActionRunTerminalFailureStatus = Extract<
  ActionRunDetail["status"],
  "failed" | "cancelled"
>

export interface ActionWaitOptions {
  readonly timeoutMs?: number
  /** Slow safety check while the event socket is healthy. */
  readonly fallbackPollIntervalMs?: number
  /** Faster storage check while the event socket is disconnected or reconnecting. */
  readonly disconnectedPollIntervalMs?: number
  readonly signal?: AbortSignal
  /**
   * When true, failed and cancelled terminal runs reject the promise. This is
   * the default because it maps naturally to mutation error states.
   */
  readonly rejectOnTerminalFailure?: boolean
}

export interface WaitForActionRunInput extends ActionWaitOptions {
  readonly runId: string
  readonly client?: Client
}

export type RequestActionAndWaitInput = Options<RequestActionData> &
  ActionWaitOptions & {
    readonly onRequested?: (response: RequestActionResponse) => void | Promise<void>
  }

export class ActionRunFailedError extends Error {
  readonly name = "ActionRunFailedError"
  readonly run: ActionRunDetail
  readonly runId: string
  readonly actionId: string
  readonly status: ActionRunTerminalFailureStatus
  readonly subject: ActionRunDetail["subject"]
  readonly error: ActionRunDetail["error"]

  constructor(run: ActionRunDetail & { readonly status: ActionRunTerminalFailureStatus }) {
    super(run.error?.message ?? `Action run '${run.id}' finished with status '${run.status}'.`)
    this.run = run
    this.runId = run.id
    this.actionId = run.actionId
    this.status = run.status
    this.subject = run.subject
    this.error = run.error
  }
}

export class ActionRunTimeoutError extends Error {
  readonly name = "ActionRunTimeoutError"
  readonly runId: string
  readonly timeoutMs: number

  constructor(params: { readonly runId: string; readonly timeoutMs: number }) {
    super(`Action run '${params.runId}' did not finish within ${params.timeoutMs}ms.`)
    this.runId = params.runId
    this.timeoutMs = params.timeoutMs
  }
}

export async function requestActionAndWait(
  input: RequestActionAndWaitInput
): Promise<ActionRunDetail> {
  const {
    timeoutMs,
    fallbackPollIntervalMs,
    disconnectedPollIntervalMs,
    rejectOnTerminalFailure,
    onRequested,
    ...requestOptions
  } = input

  const response = await requestAction<true>({
    ...requestOptions,
    throwOnError: true,
  })
  await onRequested?.(response.data)

  return waitForActionRun({
    runId: response.data.runId,
    client: input.client,
    signal: input.signal,
    timeoutMs,
    fallbackPollIntervalMs,
    disconnectedPollIntervalMs,
    rejectOnTerminalFailure,
  })
}

/**
 * Wait for a durable action run to reach a terminal status.
 *
 * Flow:
 * 1. Fetch the run detail immediately, so very fast actions that finished
 *    before the event socket opened are still observed.
 * 2. Treat action terminal events as wakeups, then fetch the run detail again;
 *    the detail endpoint is the source of truth and carries commit diff data.
 * 3. Keep a slow safety poll while the socket is healthy, and use a faster
 *    fallback poll only while the socket is disconnected or reconnecting.
 */
export function waitForActionRun(input: WaitForActionRunInput): Promise<ActionRunDetail> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_ACTION_WAIT_TIMEOUT_MS
  const fallbackPollIntervalMs =
    input.fallbackPollIntervalMs ?? DEFAULT_ACTION_WAIT_FALLBACK_POLL_MS
  const disconnectedPollIntervalMs =
    input.disconnectedPollIntervalMs ?? DEFAULT_ACTION_WAIT_DISCONNECTED_POLL_MS
  const rejectOnTerminalFailure = input.rejectOnTerminalFailure ?? true
  const signal = input.signal
  const startedAt = Date.now()

  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new Error("aborted"))
  }

  return new Promise<ActionRunDetail>((resolve, reject) => {
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    let unsubscribeFromTerminalEvents: (() => void) | undefined
    let settled = false
    let checking = false
    let checkRequested = false
    let socketHealthy = false

    const clearTimer = (timer: ReturnType<typeof setTimeout> | undefined) => {
      if (timer) clearTimeout(timer)
    }

    const cleanup = () => {
      if (settled) return
      settled = true
      clearTimer(timeoutTimer)
      clearTimer(pollTimer)
      unsubscribeFromTerminalEvents?.()
      signal?.removeEventListener("abort", onAbort)
    }

    const rejectWith = (error: unknown) => {
      cleanup()
      reject(error)
    }

    const resolveWith = (run: ActionRunDetail) => {
      cleanup()
      if (rejectOnTerminalFailure && isTerminalFailureRun(run)) {
        reject(new ActionRunFailedError(run))
        return
      }
      resolve(run)
    }

    const currentPollIntervalMs = () =>
      socketHealthy ? fallbackPollIntervalMs : disconnectedPollIntervalMs

    const schedulePoll = () => {
      if (settled || pollTimer) return
      pollTimer = setTimeout(() => {
        pollTimer = undefined
        void check()
      }, currentPollIntervalMs())
    }

    const reschedulePoll = () => {
      if (settled) return
      clearTimer(pollTimer)
      pollTimer = undefined
      schedulePoll()
    }

    const wakeAndCheck = () => {
      clearTimer(pollTimer)
      pollTimer = undefined
      void check()
    }

    const check = async () => {
      if (settled) return
      if (checking) {
        checkRequested = true
        return
      }
      checking = true
      try {
        const run = await fetchActionRun(input.runId, {
          client: input.client,
          signal,
        })
        if (run && isTerminalActionRun(run)) {
          resolveWith(run)
          return
        }
        schedulePoll()
      } catch (error) {
        rejectWith(error)
      } finally {
        checking = false
        if (!settled && checkRequested) {
          checkRequested = false
          wakeAndCheck()
        }
      }
    }

    const onAbort = () => {
      rejectWith(signal?.reason ?? new Error("aborted"))
    }

    timeoutTimer = setTimeout(
      () => {
        rejectWith(new ActionRunTimeoutError({ runId: input.runId, timeoutMs }))
      },
      Math.max(0, timeoutMs - (Date.now() - startedAt))
    )

    signal?.addEventListener("abort", onAbort, { once: true })

    unsubscribeFromTerminalEvents = events
      .actions({ client: input.client })
      .run(input.runId)
      .terminal()
      .subscribe(
        () => {
          wakeAndCheck()
        },
        {
          // Event delivery is only a wakeup path. Polling `getActionRun` remains
          // authoritative, so transient WebSocket failures should not reject.
          onError: () => undefined,
          onStateChange: (state) => {
            const nextSocketHealthy = state.connected && !state.reconnecting && !state.error
            if (nextSocketHealthy !== socketHealthy) {
              socketHealthy = nextSocketHealthy
              reschedulePoll()
            }
          },
        }
      )

    void check()
  })
}

export function isTerminalActionRun(run: Pick<ActionRunDetail, "status">): boolean {
  return run.status === "succeeded" || isTerminalFailureRun(run)
}

function isTerminalFailureRun(
  run: Pick<ActionRunDetail, "status">
): run is ActionRunDetail & { readonly status: ActionRunTerminalFailureStatus } {
  return run.status === "failed" || run.status === "cancelled"
}

async function fetchActionRun(
  runId: string,
  options: {
    readonly client?: Client
    readonly signal?: AbortSignal
  }
): Promise<ActionRunDetail | null> {
  const result = await getActionRun({
    client: options.client,
    path: { runId },
    signal: options.signal,
    throwOnError: false,
  })

  if (result.data) {
    return result.data
  }

  if (result.response.status === 404) {
    return null
  }

  throw toActionRunRequestError(result.error, runId)
}

function toActionRunRequestError(error: unknown, runId: string): Error {
  if (error instanceof Error) {
    return error
  }

  if (error && typeof error === "object" && "error" in error) {
    return new Error(String((error as { readonly error?: unknown }).error))
  }

  return new Error(`[SixbClient] Failed to fetch action run '${runId}'.`)
}
