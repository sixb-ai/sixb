import type { MaintenanceHeartbeatRecord, MaintenancePassHealth } from "../storage"

/**
 * Largest delay `setTimeout` accepts before it overflows its 32-bit counter. Node coerces anything
 * larger to `1`, which would spin the loop until a far occurrence came into range.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647

const DEFAULT_BEAT_EVERY_MS = 30_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000

/** One kind of upkeep. The loop decides when it runs; the pass only says when it is due. */
export interface MaintenancePass {
  readonly id: string
  /** How long one run may take. Past it the run's signal aborts and the run counts as a failure. */
  readonly budgetMs: number
  /**
   * When this pass is next due, given when its last run ended: null before the first one. A null
   * answer means nothing to do: the loop asks again the next time it wakes.
   */
  nextRunAt(now: Date, lastFinishedAt: Date | null): Date | null
  run(signal: AbortSignal): Promise<void>
}

export interface IntervalPassInput {
  readonly id: string
  /** The pause between one run's end and the next run's start. */
  readonly intervalMs: number
  readonly budgetMs: number
  run(signal: AbortSignal): Promise<void>
}

/** A pass that runs as soon as the loop starts, then again `intervalMs` after each run ends. */
export function everyMs(input: IntervalPassInput): MaintenancePass {
  return {
    id: input.id,
    budgetMs: input.budgetMs,
    nextRunAt: (now, lastFinishedAt) =>
      lastFinishedAt === null ? now : new Date(lastFinishedAt.getTime() + input.intervalMs),
    run: (signal) => input.run(signal),
  }
}

export interface MaintenanceHeartbeat {
  /** The longest the loop waits between two beats. Defaults to 30 seconds. */
  readonly everyMs?: number
  write(beat: Omit<MaintenanceHeartbeatRecord, "projectId">): Promise<void>
}

export interface MaintenanceFailure {
  /** The failing pass, or `heartbeat` when the beat could not be written. */
  readonly passId: string
  readonly consecutiveFailures: number
}

export interface MaintenanceLoopOptions {
  readonly passes: readonly MaintenancePass[]
  readonly heartbeat?: MaintenanceHeartbeat
  readonly onError: (error: unknown, failure: MaintenanceFailure) => void
  readonly now?: () => Date
  /** Reports a pass still running this long after `stop()`, which keeps waiting for it. */
  readonly shutdownTimeoutMs?: number
}

interface PassState {
  readonly pass: MaintenancePass
  lastFinishedAt: Date | null
  lastSucceededAt: Date | null
  consecutiveFailures: number
  run: ActiveRun | null
}

interface ActiveRun {
  settled: Promise<void>
  readonly controller: AbortController
  /** When the budget runs out. A run that outlives it counts as one more failure per budget. */
  deadline: Date
}

/**
 * Runs maintenance passes on one timer, armed for whatever comes next: a pass that is due, a run's
 * budget, or a beat.
 *
 * Passes never wait for each other. Each has at most one run in flight, and its failures, its slow
 * runs and its budget are its own, so one that hangs costs the others nothing. A run past its
 * budget is told to stop and keeps its slot until it does: starting another beside it would put
 * two runs of one pass in flight.
 */
export class MaintenanceLoop {
  private readonly states: readonly PassState[]
  private readonly now: () => Date
  private readonly beatEveryMs: number
  private readonly shutdownTimeoutMs: number
  private started = false
  private stopping: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private nextBeatAt: Date | null = null
  private beating: Promise<void> | null = null
  private beatPending = false

  constructor(private readonly options: MaintenanceLoopOptions) {
    assertUniquePassIds(options.passes)
    this.states = options.passes.map(initialState)
    this.now = options.now ?? (() => new Date())
    this.beatEveryMs = options.heartbeat?.everyMs ?? DEFAULT_BEAT_EVERY_MS
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
  }

  /** A start counts as a first run: interval passes run at once, whatever ran before a stop. */
  start(): void {
    if (this.started) return

    for (const state of this.states) state.lastFinishedAt = null
    this.nextBeatAt = null
    this.started = true
    this.tick()
  }

  /** Stops arming the timer, tells running passes to stop and waits for them and the last beat. */
  stop(): Promise<void> {
    this.stopping ??= this.shutDown().finally(() => {
      this.stopping = null
    })
    return this.stopping
  }

  /**
   * Runs one pass, or every pass, right away and resolves once they ended and that was written. A
   * pass already running is joined, not started again. Failures are reported and counted as on any
   * other run.
   */
  async runNow(id?: string): Promise<void> {
    if (this.stopping) return this.stopping

    const now = this.now()
    const states = this.states.filter((state) => id === undefined || state.pass.id === id)
    if (states.length === 0) throw new Error(`[Sixb] Unknown maintenance pass '${id}'.`)

    await Promise.all(states.map((state) => (state.run ?? this.startRun(state, now)).settled))
    await this.beating
  }

  private async shutDown(): Promise<void> {
    this.started = false
    this.clearTimer()

    const active = this.states.flatMap((state) => (state.run ? [state.run] : []))
    for (const run of active) run.controller.abort()

    const settled = Promise.all([...active.map((run) => run.settled), this.beating])
    if (!(await settlesWithin(settled, this.shutdownTimeoutMs))) {
      this.reportShutdownOverrun()
    }
    await settled
  }

  private tick(): void {
    this.clearTimer()
    const now = this.now()

    for (const state of this.states) {
      if (state.run) this.enforceBudget(state, state.run, now)
      else if (this.isDue(state, now)) this.startRun(state, now)
    }

    if (this.options.heartbeat && (this.nextBeatAt === null || this.nextBeatAt <= now)) {
      this.beat()
    }
    this.arm()
  }

  private arm(): void {
    if (!this.started) return
    this.clearTimer()

    const wakeAt = this.nextWakeAt(this.now())
    if (wakeAt === null) return

    // Waking early is harmless: a clamped delay becomes several sleeps instead of one.
    const delayMs = Math.min(Math.max(0, wakeAt - this.now().getTime()), MAX_TIMER_DELAY_MS)
    this.timer = setTimeout(() => this.tick(), delayMs)
    this.timer.unref?.()
  }

  private nextWakeAt(now: Date): number | null {
    const times = this.states.flatMap((state) => {
      const at = state.run ? state.run.deadline : this.nextRunAt(state, now)
      return at ? [at.getTime()] : []
    })
    if (this.nextBeatAt) times.push(this.nextBeatAt.getTime())

    return times.length > 0 ? Math.min(...times) : null
  }

  private clearTimer(): void {
    if (this.timer === null) return

    clearTimeout(this.timer)
    this.timer = null
  }

  private isDue(state: PassState, now: Date): boolean {
    const dueAt = this.nextRunAt(state, now)
    return dueAt !== null && dueAt <= now
  }

  /** A pass that cannot say when it is due fails that one time, and asks again at the next wake. */
  private nextRunAt(state: PassState, now: Date): Date | null {
    try {
      return state.pass.nextRunAt(now, state.lastFinishedAt)
    } catch (error) {
      this.recordFailure(state, error)
      return null
    }
  }

  private startRun(state: PassState, now: Date): ActiveRun {
    const run: ActiveRun = {
      settled: Promise.resolve(),
      controller: new AbortController(),
      deadline: new Date(now.getTime() + state.pass.budgetMs),
    }

    // Set before the pass starts: a pass that throws at once clears it again.
    state.run = run
    run.settled = this.execute(state, run.controller.signal)
    return run
  }

  private async execute(state: PassState, signal: AbortSignal): Promise<void> {
    try {
      await state.pass.run(signal)
      if (!signal.aborted) this.recordSuccess(state)
    } catch (error) {
      // An aborted run says nothing: stopping is no failure, and a spent budget counted already.
      if (!signal.aborted) this.recordFailure(state, error)
    }

    state.run = null
    state.lastFinishedAt = this.now()

    if (this.stopping) return
    this.beat()
    this.arm()
  }

  private enforceBudget(state: PassState, run: ActiveRun, now: Date): void {
    if (run.deadline > now) return

    const budgetMs = state.pass.budgetMs
    run.controller.abort()
    run.deadline = new Date(now.getTime() + budgetMs)
    this.recordFailure(
      state,
      new Error(`[Sixb] Maintenance pass '${state.pass.id}' is still running past ${budgetMs}ms.`)
    )
  }

  private recordSuccess(state: PassState): void {
    state.lastSucceededAt = this.now()
    state.consecutiveFailures = 0
  }

  private recordFailure(state: PassState, error: unknown): void {
    state.consecutiveFailures += 1
    this.report(error, { passId: state.pass.id, consecutiveFailures: state.consecutiveFailures })
  }

  /** One write at a time. A hung write leaves the beat stale, which is what a reader should see. */
  private beat(): void {
    const heartbeat = this.options.heartbeat
    if (!heartbeat) return

    const now = this.now()
    this.nextBeatAt = new Date(now.getTime() + this.beatEveryMs)

    if (this.beating) {
      this.beatPending = true
      return
    }

    this.beating = this.writeBeat(heartbeat, now).finally(() => {
      this.beating = null
      if (!this.beatPending || this.stopping) return

      this.beatPending = false
      this.beat()
    })
  }

  private async writeBeat(heartbeat: MaintenanceHeartbeat, beatAt: Date): Promise<void> {
    try {
      await heartbeat.write({
        beatAt,
        everyMs: this.beatEveryMs,
        passes: this.states.map(passHealth),
      })
    } catch (error) {
      this.report(error, { passId: "heartbeat", consecutiveFailures: 1 })
    }
  }

  private reportShutdownOverrun(): void {
    const running = this.states.filter((state) => state.run).map((state) => state.pass.id)
    const error = new Error(
      `[Sixb] Maintenance is still stopping after ${this.shutdownTimeoutMs}ms; waiting for ${running.join(", ")}.`
    )
    this.report(error, { passId: running[0] ?? "heartbeat", consecutiveFailures: 1 })
  }

  private report(error: unknown, failure: MaintenanceFailure): void {
    try {
      this.options.onError(error, failure)
    } catch {
      // A failure stays counted; a reporter that throws must not stop the loop.
    }
  }
}

function initialState(pass: MaintenancePass): PassState {
  return {
    pass,
    lastFinishedAt: null,
    lastSucceededAt: null,
    consecutiveFailures: 0,
    run: null,
  }
}

function passHealth(state: PassState): MaintenancePassHealth {
  return {
    id: state.pass.id,
    lastSucceededAt: state.lastSucceededAt,
    consecutiveFailures: state.consecutiveFailures,
  }
}

function assertUniquePassIds(passes: readonly MaintenancePass[]): void {
  const seen = new Set<string>()
  for (const pass of passes) {
    if (seen.has(pass.id)) throw new Error(`[Sixb] Duplicate maintenance pass '${pass.id}'.`)
    seen.add(pass.id)
  }
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })

  const result = await Promise.race([promise.then(() => true as const), timedOut])
  if (timer !== undefined) clearTimeout(timer)
  return result
}
