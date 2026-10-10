import { reportRunFailure } from "../../error-reporting/capability"
import { createSixbError, type SixbCodedError } from "../../errors/internal"
import type { ActionRunFailure, ActionRunRecord } from "../../storage"
import type { PersistedActionRun } from "../run-persistence"
import { emitActionRequested, emitActionTerminal } from "./events"
import { type ActionRunHost, executePersistedActionRun } from "./execute"
import { toActionRunFailure } from "./normalize"
import { UnrecordedActionRunError } from "./run-action"

/** A request for an Action run, handed over to persist and run in the requesting process. */
export interface ActionRunRequest {
  /** Persist the run, or find the earlier request with the same run id. */
  readonly persist: () => Promise<PersistedActionRun>
  /** Cancels the run before its irreversible boundary. */
  readonly signal?: AbortSignal
  /** Called once the run is durable, before it executes. A throw fails the run unexecuted. */
  readonly onRequested?: (runId: string) => void | Promise<void>
}

/** The run that answers a request: executed by it, or replayed from an earlier one. */
export interface RequestedActionRun {
  readonly run: ActionRunRecord
  /** The run id was requested before, so this request ran nothing. */
  readonly replayed: boolean
}

type CreatedActionRun = Extract<PersistedActionRun, { readonly kind: "created" }>

/**
 * Runs requested Actions in the calling process, and tracks each request until its run ends so that
 * a stopping process can wait for them.
 *
 * `SixbHost` registers one on itself and on the context its bound SDKs share, so a request can
 * execute its run without holding the host.
 */
export class ActionRunExecutor {
  private readonly inFlight = new Set<Promise<unknown>>()
  private stopping = false

  constructor(private readonly host: ActionRunHost) {}

  /**
   * Persist a requested run and execute it to its terminal record.
   *
   * The request is tracked from before its run is persisted, so that {@link drain} waits for a run
   * still being persisted too. Once the process is stopping, a new request is refused before
   * anything is persisted.
   *
   * Past persistence, the request either resolves with the run's record or rejects with
   * `internal.unexpected`: see {@link failRequest}.
   */
  request(request: ActionRunRequest): Promise<RequestedActionRun> {
    if (this.stopping) {
      return Promise.reject(
        createSixbError(
          "runtime.stopping",
          "[Sixb] The runtime is stopping and starts no new Action run; retry the request."
        )
      )
    }

    const requested = this.persistAndExecute(request)
    const settled: Promise<unknown> = requested
      .catch(() => undefined)
      .finally(() => {
        this.inFlight.delete(settled)
      })
    this.inFlight.add(settled)
    return requested
  }

  /** Refuse new requests, then wait for those in flight for at most `timeoutMs`. */
  async drain(timeoutMs: number): Promise<void> {
    this.stopping = true
    if (this.inFlight.size === 0) return
    if (await settleWithin([...this.inFlight], Math.max(0, timeoutMs))) return
    console.error(
      `[Sixb] Stopped waiting after ${timeoutMs} ms for ${this.inFlight.size} in-flight Action run(s).`
    )
  }

  private async persistAndExecute(request: ActionRunRequest): Promise<RequestedActionRun> {
    const persisted = await request.persist()
    if (persisted.kind === "finished") {
      return { run: persisted.run, replayed: true }
    }
    return { run: await this.execute(persisted, request), replayed: false }
  }

  private async execute(
    persisted: CreatedActionRun,
    request: ActionRunRequest
  ): Promise<ActionRunRecord> {
    const { run, execution } = persisted
    try {
      await request.onRequested?.(run.id)
    } catch (error) {
      throw await this.failUnexecuted(run, error)
    }

    try {
      await emitActionRequested(this.host.events, run, execution.correlationId)
      const { result } = await executePersistedActionRun(this.host, {
        run,
        execution,
        signal: request.signal,
        attempt: 1,
      })
      if (!("skipped" in result)) {
        await emitActionTerminal(this.host.events, result, execution.correlationId)
      }
      return result.record
    } catch (error) {
      throw this.failRequest(
        run,
        error,
        error instanceof UnrecordedActionRunError ? error.failure : undefined
      )
    }
  }

  /** Close a run whose requester withdrew before it executed, so its id does not stay in progress. */
  private async failUnexecuted(run: ActionRunRecord, error: unknown): Promise<SixbCodedError> {
    const failedAt = new Date()
    const failure = toActionRunFailure(error, "request", {
      actionId: run.actionId,
      runId: run.id,
      at: failedAt,
    })
    await this.host.storage.actionRuns
      ?.finish({
        projectId: this.host.id,
        id: run.id,
        status: "failed",
        finishedAt: failedAt,
        error: failure,
      })
      // The request fails either way; a run left queued is visible as such.
      .catch(() => undefined)
    return this.failRequest(run, error, failure)
  }

  /**
   * Fail a request whose run was persisted.
   *
   * The run may have started, so the caller gets an `internal.unexpected` error that names the run
   * and says how to get its record, never what went wrong inside it: that goes to `onError`, once,
   * with the failure the run recorded or would have recorded. Errors outside the run's phases are
   * the request's own, and fail it in the `request` phase.
   */
  private failRequest(
    run: ActionRunRecord,
    error: unknown,
    failure?: ActionRunFailure
  ): SixbCodedError {
    const ids = { actionId: run.actionId, runId: run.id }
    const requestError = createSixbError(
      "internal.unexpected",
      `[Sixb] Action run '${run.id}' was requested, but its record could not be returned. ` +
        "Request it again with the same runId to get it.",
      { cause: error, details: ids }
    )
    reportRunFailure(this.host, requestError, {
      projectId: this.host.id,
      runKind: "action",
      run: ids,
      failure: failure ?? toActionRunFailure(error, "request", { ...ids, at: new Date() }),
    })
    return requestError
  }
}

const actionRunExecutorKey: unique symbol = Symbol("sixb.actionRunExecutor")

interface ActionRunExecutorOwner {
  readonly [actionRunExecutorKey]?: ActionRunExecutor
}

/**
 * Attach the executor to a host or runtime context. The property is enumerable so that spreading a
 * context into a narrower one carries it along.
 */
export function registerActionRunExecutor(owner: object, executor: ActionRunExecutor): void {
  const registered = findActionRunExecutor(owner)
  if (registered && registered !== executor) {
    throw new Error("[Sixb] An Action run executor is already registered for this owner.")
  }
  Object.defineProperty(owner, actionRunExecutorKey, {
    configurable: false,
    enumerable: true,
    value: executor,
    writable: false,
  })
}

export function getActionRunExecutor(owner: object): ActionRunExecutor {
  const executor = findActionRunExecutor(owner)
  if (executor) return executor
  throw new Error(
    "[Sixb] Actions cannot run from this runtime context: it was not bound by SixbHost.withScope()."
  )
}

/** Copy the executor, when there is one, onto an internal runtime context being reconstructed. */
export function shareActionRunExecutor(source: object, target: object): void {
  const executor = findActionRunExecutor(source)
  if (executor) registerActionRunExecutor(target, executor)
}

/**
 * Refuse new Action requests on this host, then wait for at most `timeoutMs` for those in flight.
 *
 * Every `SixbHost` has an executor from construction on, so an object without one is not a host.
 */
export async function drainActionRuns(host: object, timeoutMs: number): Promise<void> {
  const executor = findActionRunExecutor(host)
  if (!executor) {
    throw new Error("[Sixb] Cannot drain Action runs: this object is not a SixbHost.")
  }
  await executor.drain(timeoutMs)
}

function findActionRunExecutor(owner: object): ActionRunExecutor | undefined {
  return (owner as ActionRunExecutorOwner)[actionRunExecutorKey]
}

async function settleWithin(
  promises: readonly Promise<unknown>[],
  timeoutMs: number
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.allSettled(promises).then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
