import { createSixbError, isSixbError } from "../../errors/internal"

/** How long an Action run has to reach its irreversible boundary, and its effects after commit. */
export const ACTION_TIMEOUT_MS = 30_000

/**
 * How long a stopping process waits for its in-flight Action runs: the deadline, plus a margin.
 *
 * It does not bound a whole run. Edits past the boundary are uninterruptible and effects get up to
 * another 30 seconds, so a run can still be executing when the wait ends. A deployment's kill
 * timeout must exceed this bound.
 */
export const ACTION_RUN_DRAIN_TIMEOUT_MS = ACTION_TIMEOUT_MS + 5_000

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
 * records. Effects run after the commit under a deadline of their own.
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
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()

  constructor(input: ActionRunSignalsInput) {
    this.input = input
    const deadline = this.startDeadline("run")
    this.beforeBoundary = input.caller ? AbortSignal.any([deadline, input.caller]) : deadline
  }

  /** The run stopped before its boundary because its deadline elapsed first. */
  get timedOut(): boolean {
    return this.beforeBoundary.aborted && isActionTimeout(this.beforeBoundary.reason)
  }

  /** The run stopped before its boundary because its caller aborted first. */
  get cancelled(): boolean {
    return this.beforeBoundary.aborted && !this.timedOut
  }

  /** Start the deadline the effects phase runs under. */
  startEffects(): AbortSignal {
    return this.startDeadline("effects")
  }

  /** Release every pending deadline timer. */
  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }

  private startDeadline(scope: "run" | "effects"): AbortSignal {
    const controller = new AbortController()
    const timeoutMs = this.input.timeoutMs ?? ACTION_TIMEOUT_MS
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      controller.abort(
        createSixbError(
          "action.timeout",
          `[Sixb] Action run '${this.input.runId}' exceeded its ${timeoutMs} ms ${scope} deadline.`,
          { details: { actionId: this.input.actionId, runId: this.input.runId } }
        )
      )
    }, timeoutMs)
    this.timers.add(timer)
    return controller.signal
  }
}

export function isActionTimeout(error: unknown): boolean {
  return isSixbError(error) && error.code === "action.timeout"
}
