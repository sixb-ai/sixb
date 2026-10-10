import { reportRunFailure } from "../../error-reporting/capability"
import { createSixbError, type SixbCodedError } from "../../errors/internal"
import type { ActionRunRecord } from "../../storage"
import {
  type ActionRunRequestPayload,
  type AssertCanReuseActionRun,
  assertCanReuseActionRun,
  type PersistedActionRun,
} from "../run-persistence"
import { type ActionRunHost, executeActionRun } from "./execute"
import { toActionRunFailure } from "./normalize"
import { UnrecordedActionRunError } from "./run-action"
import type { PendingActionRun } from "./types"

/** A request for an Action run, handed over to execute in the requesting process. */
export interface ActionRunRequest {
  readonly runId: string
  readonly payload: ActionRunRequestPayload
  /** Find the record of an earlier request with the same run id, or create the run's execution. */
  readonly persist: () => Promise<PersistedActionRun>
  /** Refuse a run that already exists under the run id, when this request's caller may not have it. */
  readonly assertCanReuse: AssertCanReuseActionRun
  /** Cancels the run before its irreversible boundary. */
  readonly signal?: AbortSignal
  /** Called once the run's execution exists, before the run executes. A throw starts nothing. */
  readonly onRequested?: (runId: string) => void | Promise<void>
}

type NewActionRun = Extract<PersistedActionRun, { readonly kind: "new" }>

/** A request of this process that holds a run id, from before it looks the run id up. */
interface HeldRunId {
  /**
   * The run once its execution exists. It resolves with `null` when the request executes nothing,
   * having found a record or failed before, and the run id is released by then.
   */
  readonly pending: Promise<PendingActionRun | null>
}

/**
 * Runs requested Actions in the calling process, and tracks each request until its run is recorded
 * and its effects ended, so that a stopping process can wait for them.
 *
 * `SixbHost` registers one on itself and on the context its bound SDKs share, so a request can
 * execute its run without holding the host.
 */
export class ActionRunExecutor {
  private readonly inFlight = new Set<Promise<void>>()
  /** Run ids held by a request of this process, until it ends. */
  private readonly held = new Map<string, HeldRunId>()
  private stopping = false

  constructor(private readonly host: ActionRunHost) {}

  /**
   * Execute a requested run to its terminal record, or answer with the record of an earlier request
   * for the same run id.
   *
   * The request is tracked from before anything is persisted, so that {@link drain} waits for it
   * from the start. Once the process is stopping, a new request is refused before anything is
   * persisted. A request for a run id that this process is executing is refused as in progress:
   * see {@link joinHeldRunId}. A request for the same run id in another process executes too, and
   * the request that records it second answers with the first one's record, under the same checks
   * as any record it finds.
   *
   * Once the run's execution exists, the request either resolves with the run's record or rejects
   * with `internal.unexpected`: see {@link failRequest}.
   */
  request(request: ActionRunRequest): Promise<ActionRunRecord> {
    if (this.stopping) {
      return Promise.reject(
        createSixbError(
          "runtime.stopping",
          "[Sixb] The runtime is stopping and starts no new Action run; retry the request."
        )
      )
    }
    const requested = this.dispatch(request)
    this.track(requested)
    return requested
  }

  /**
   * Refuse new requests, then wait for at most `timeoutMs` for those in flight and for the effects
   * they start meanwhile.
   */
  async drain(timeoutMs: number): Promise<void> {
    this.stopping = true
    const deadline = Date.now() + Math.max(0, timeoutMs)
    // A request that ends starts its run's effects before it settles, so they are tracked by the
    // time the wait for the request returns: wait again until nothing is left.
    while (this.inFlight.size > 0) {
      if (!(await settleWithin([...this.inFlight], deadline - Date.now()))) {
        console.error(
          `[Sixb] Stopped waiting after ${timeoutMs} ms for ${this.inFlight.size} in-flight Action run(s).`
        )
        return
      }
    }
  }

  /** Track work until it settles. Whoever started it handles how it ends; this only waits. */
  private track(work: Promise<unknown>): void {
    const settled: Promise<void> = work
      .then(
        () => undefined,
        () => undefined
      )
      .finally(() => {
        this.inFlight.delete(settled)
      })
    this.inFlight.add(settled)
  }

  private async dispatch(request: ActionRunRequest): Promise<ActionRunRecord> {
    // A request that held the run id but executes nothing releases it before its `pending`
    // settles, so each turn of this loop finds the run id free or held by another request.
    for (let held = this.held.get(request.runId); held; held = this.held.get(request.runId)) {
      const run = await held.pending
      if (run) return this.joinHeldRunId(run, request)
    }
    return this.holdAndExecute(request)
  }

  /**
   * Answer a request for a run id that a request of this process executes.
   *
   * Nothing is stored about a run before it ends, so this process is the only one that knows the
   * run is in progress. The request gets what a stored run would give it: refused when its caller
   * may not have the run or asks for something else, the record once it is written, and
   * `action.run_in_progress` until then.
   */
  private async joinHeldRunId(
    run: PendingActionRun,
    request: ActionRunRequest
  ): Promise<ActionRunRecord> {
    await assertCanReuseActionRun(run, request)
    const recorded = await this.host.storage.actionRuns?.getById({
      projectId: run.projectId,
      id: run.id,
    })
    if (recorded) return recorded
    throw createSixbError(
      "action.run_in_progress",
      `[Sixb] Action run '${run.id}' is already in progress.`,
      { details: { actionId: run.actionId, runId: run.id } }
    )
  }

  private async holdAndExecute(request: ActionRunRequest): Promise<ActionRunRecord> {
    const { runId } = request
    const pending = Promise.withResolvers<PendingActionRun | null>()
    this.held.set(runId, { pending: pending.promise })
    try {
      const persisted = await request.persist()
      if (persisted.kind === "recorded") return persisted.run
      pending.resolve(persisted.run)
      return await this.execute(persisted, request)
    } finally {
      this.held.delete(runId)
      pending.resolve(null)
    }
  }

  private async execute(
    persisted: NewActionRun,
    request: ActionRunRequest
  ): Promise<ActionRunRecord> {
    const { run, execution } = persisted
    try {
      await request.onRequested?.(run.id)
    } catch (error) {
      // Nothing ran and nothing is recorded: the error belongs to the caller whose hook threw.
      throw createSixbError(
        "internal.unexpected",
        `[Sixb] Action run '${run.id}' did not start: its requester failed before it executed.`,
        { cause: error, details: { actionId: run.actionId, runId: run.id } }
      )
    }

    let outcome: Awaited<ReturnType<typeof executeActionRun>>
    try {
      outcome = await executeActionRun(this.host, { run, execution, signal: request.signal })
    } catch (error) {
      throw this.failRequest(run, error)
    }

    if (!outcome.recorded) {
      // Another process recorded this run id first: its record answers this request only under
      // the checks a record found before executing gets.
      await assertCanReuseActionRun(outcome.record, request)
      return outcome.record
    }
    if (outcome.effects) this.startEffects(run, outcome.effects)
    return outcome.record
  }

  /**
   * Start a recorded run's effects once the request has returned, tracked until they end. Deferring
   * them keeps a handler that does synchronous work before its first `await` from delaying the
   * response.
   */
  private startEffects(run: PendingActionRun, effects: () => Promise<void>): void {
    this.track(
      new Promise<void>((resolve) => setImmediate(resolve))
        .then(effects)
        .catch((error: unknown) => {
          console.error(`[Sixb] Action run '${run.id}' failed to run its effects:`, error)
        })
    )
  }

  /**
   * Fail a request whose run's execution exists.
   *
   * The run may have executed, so the caller gets an `internal.unexpected` error that names the run
   * and says what requesting it again does, never what went wrong inside it: that goes to
   * `onError`, once, with the failure the run recorded or would have recorded. Errors outside the
   * run's phases fail it in `validation`, the phase it starts in.
   */
  private failRequest(run: PendingActionRun, error: unknown): SixbCodedError {
    const ids = { actionId: run.actionId, runId: run.id }
    const requestError = createSixbError(
      "internal.unexpected",
      `[Sixb] Action run '${run.id}' was requested, but its record could not be written. ` +
        "Requesting it again with the same runId returns its record if it was written, and runs " +
        "it again otherwise.",
      { cause: error, details: ids }
    )
    const at = new Date()
    reportRunFailure(this.host, requestError, {
      projectId: this.host.id,
      runKind: "action",
      run: ids,
      failure:
        error instanceof UnrecordedActionRunError
          ? (error.record.error ??
            toActionRunFailure(error.cause, error.record.phase, { ...ids, at }))
          : toActionRunFailure(error, "validation", { ...ids, at }),
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
