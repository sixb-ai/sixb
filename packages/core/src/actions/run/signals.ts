import { createSixbError, isSixbError } from "../../errors/internal"

/** How long an Action run has to reach its irreversible boundary, and its effects after commit. */
export const ACTION_TIMEOUT_MS = 30_000

/**
 * How long a stopping process waits for its in-flight Action runs and their effects: a run's
 * deadline, then its effects' deadline, plus a margin.
 *
 * It does not bound a whole run. Edits past the boundary are uninterruptible, and effects start
 * only once they committed, so a run or its effects can still be executing when the wait ends. A
 * deployment's kill timeout must exceed this bound.
 */
export const ACTION_RUN_DRAIN_TIMEOUT_MS = 2 * ACTION_TIMEOUT_MS + 5_000

export interface ActionRunSignalsInput {
  readonly actionId: string
  readonly runId: string
  /** The caller's cancellation. It applies before the boundary only. */
  readonly caller?: AbortSignal
  /** Test-only override of {@link ACTION_TIMEOUT_MS}. */
  readonly timeoutMs?: number
}

/**
 * The cancellation one Action run observes, phase by phase.
 *
 * The irreversible boundary is a succeeded writeback, or the commit of an Action without one. Before
 * it, validation, writeback and edits run under {@link beforeBoundary}, which aborts when the run's
 * deadline elapses or its caller aborts. After it, edits and commit run under
 * {@link uninterruptible}: abandoning them would strand an external change that the ontology never
 * records. Effects run after the commit under a deadline of their own, which
 * {@link startEffects} starts.
 *
 * Cancellation is cooperative: a handler stops early only when it forwards its `signal` to what it
 * awaits.
 */
export class ActionRunSignals {
  readonly beforeBoundary: AbortSignal
  /**
   * Never aborts, for the work that must run to completion once it starts. One per run: whatever
   * listens to it is released with the run, not kept for the life of the process.
   */
  readonly uninterruptible: AbortSignal = new AbortController().signal

  private readonly input: ActionRunSignalsInput
  private readonly deadline: ActionDeadline

  constructor(input: ActionRunSignalsInput) {
    this.input = input
    this.deadline = new ActionDeadline(input, "run")
    this.beforeBoundary = input.caller
      ? AbortSignal.any([this.deadline.signal, input.caller])
      : this.deadline.signal
  }

  /**
   * Why the run stopped before its boundary: its deadline's `action.timeout` when the deadline
   * elapsed first, or else a `runtime.cancelled` error caused by what its caller aborted with.
   */
  stopReason(): unknown {
    const reason = this.beforeBoundary.reason
    if (isActionTimeout(reason)) return reason
    return createSixbError(
      "runtime.cancelled",
      `[Sixb] Action run '${this.input.runId}' was cancelled by its caller.`,
      { cause: reason, details: { actionId: this.input.actionId, runId: this.input.runId } }
    )
  }

  /**
   * Start the deadline the run's effects run under. It is independent of the run's own: effects
   * start after the run is recorded, and the caller of the deadline disposes it once they end.
   */
  startEffects(): ActionDeadline {
    return new ActionDeadline(this.input, "effects")
  }

  /** Release the run's deadline timer. */
  dispose(): void {
    this.deadline.dispose()
  }
}

/** A signal that aborts with `action.timeout` once its scope's deadline elapses. */
export class ActionDeadline {
  readonly signal: AbortSignal
  private readonly timer: ReturnType<typeof setTimeout>

  constructor(
    input: Pick<ActionRunSignalsInput, "actionId" | "runId" | "timeoutMs">,
    scope: "run" | "effects"
  ) {
    const controller = new AbortController()
    const timeoutMs = input.timeoutMs ?? ACTION_TIMEOUT_MS
    this.signal = controller.signal
    this.timer = setTimeout(() => {
      controller.abort(
        createSixbError(
          "action.timeout",
          `[Sixb] Action run '${input.runId}' exceeded its ${timeoutMs} ms ${scope} deadline.`,
          { details: { actionId: input.actionId, runId: input.runId } }
        )
      )
    }, timeoutMs)
  }

  /** Release the deadline timer. */
  dispose(): void {
    clearTimeout(this.timer)
  }
}

export function isActionTimeout(error: unknown): boolean {
  return isSixbError(error) && error.code === "action.timeout"
}
