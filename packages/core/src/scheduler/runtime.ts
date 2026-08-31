import type { DomainEventLog } from "../events"
import { nextCronOccurrence } from "../schedules/next-occurrence"
import type { CronScheduleDefinition, ScheduleDefinition } from "../schedules/types"
import { SchedulerValidationError } from "./errors"

/** Matches the `onError` flush budget: long enough for a healthy broker, short enough to shut down. */
const DEFAULT_EMIT_DRAIN_TIMEOUT_MS = 5_000

/**
 * Largest delay `setTimeout` accepts before it overflows its 32-bit counter.
 *
 * Node coerces anything larger to `1`, so an unclamped monthly or yearly occurrence would fire
 * immediately, find nothing due, and re-arm on the next tick -- spinning the event loop and
 * emitting a `TimeoutOverflowWarning` for every re-arm until the occurrence came into range.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647

export interface SchedulerRuntimeOptions {
  schedules: readonly ScheduleDefinition[]
  events: DomainEventLog
  now?: () => Date
}

/** Process lifecycle surface exposed by SixbHost. */
export interface SchedulerController {
  start(): Promise<void>
  stop(): Promise<void>
}

export class SchedulerRuntime implements SchedulerController {
  private readonly schedules: readonly CronScheduleDefinition[]
  private readonly events: DomainEventLog
  private readonly now: () => Date
  private started = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly nextOccurrences = new Map<string, Date>()
  private readonly pendingEmits = new Set<Promise<void>>()

  constructor(options: SchedulerRuntimeOptions) {
    this.schedules = options.schedules.filter(isCronSchedule)
    this.events = options.events
    this.now = options.now ?? (() => new Date())
  }

  async start(): Promise<void> {
    if (this.started) return

    const seenIds = new Set<string>()
    for (const schedule of this.schedules) {
      if (seenIds.has(schedule.id)) {
        throw new SchedulerValidationError(`Duplicate schedule id '${schedule.id}'.`)
      }
      seenIds.add(schedule.id)
    }

    const now = this.now()
    for (const schedule of this.schedules) {
      // Syntactically valid expressions can still have no reachable occurrence -- `0 0 30 2 *`
      // parses but never matches. `tick()` already tolerates that per schedule; start-up must
      // agree, or one unschedulable expression stops every other schedule in the project and
      // crash-loops the scheduler role.
      try {
        const next = nextCronOccurrence(schedule.trigger.expression, now, schedule.trigger.timezone)
        this.nextOccurrences.set(schedule.id, next)
      } catch (error) {
        console.error(
          `[Sixb] Scheduler failed to compute next occurrence for '${schedule.id}':`,
          error
        )
      }
    }

    this.armTimer()
    this.started = true
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.nextOccurrences.clear()
    this.started = false
    await this.drainEmits()
  }

  /**
   * Wait for in-flight `schedule.triggered` emits so shutdown does not return mid-delivery.
   *
   * Bounded on purpose. `emit` never rejects, so an emit that never *settles* — a broker that accepts
   * the call and then hangs — would make `stop()` wait forever, turning a provider stall into a
   * process that cannot shut down. Losing the wait is recoverable; losing shutdown is not.
   */
  private async drainEmits(timeoutMs = DEFAULT_EMIT_DRAIN_TIMEOUT_MS): Promise<void> {
    if (this.pendingEmits.size === 0) return

    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const drained = await Promise.race([
        Promise.all([...this.pendingEmits]).then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs)
        }),
      ])
      if (!drained) {
        console.error(
          `[Sixb] Timed out after ${timeoutMs}ms waiting for ${this.pendingEmits.size} schedule emit(s) to settle.`
        )
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private armTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }

    let earliest: Date | null = null
    for (const date of this.nextOccurrences.values()) {
      if (earliest === null || date.getTime() < earliest.getTime()) {
        earliest = date
      }
    }

    if (earliest === null) return

    // Waking early is harmless: `tick()` re-arms from the same occurrence map, so a clamped delay
    // just becomes several sleeps instead of one.
    const delayMs = Math.min(
      Math.max(0, earliest.getTime() - this.now().getTime()),
      MAX_TIMER_DELAY_MS
    )
    this.timer = setTimeout(() => this.tick(), delayMs)
  }

  private tick(): void {
    const now = this.now()

    // Collect all due schedules
    const dueSchedules: Array<{ schedule: CronScheduleDefinition; occurrenceAt: Date }> = []
    for (const schedule of this.schedules) {
      const occurrence = this.nextOccurrences.get(schedule.id)
      if (occurrence && occurrence.getTime() <= now.getTime()) {
        dueSchedules.push({ schedule, occurrenceAt: occurrence })
      }
    }

    // Emit events and recalculate next occurrences
    for (const { schedule, occurrenceAt } of dueSchedules) {
      const occurrenceAtIso = occurrenceAt.toISOString()
      // `emit` reports instead of rejecting, so nothing is swallowed here. The previous
      // `void this.events.append(...)` inside a `try` could not observe a rejection at all: a broker
      // outage meant the schedule silently never fired.
      this.track(
        this.events.emit(
          {
            events: [
              {
                type: "schedule.triggered",
                payload: {
                  scheduleId: schedule.id,
                  occurrenceAt: occurrenceAtIso,
                  triggeredAt: now.toISOString(),
                  occurrenceKey: `${schedule.id}:${occurrenceAtIso}`,
                },
              },
            ],
          },
          { source: "Sixb" }
        )
      )

      // Calculate next from the logical occurrence time (not now) to avoid drift
      try {
        const next = nextCronOccurrence(
          schedule.trigger.expression,
          occurrenceAt,
          schedule.trigger.timezone
        )
        this.nextOccurrences.set(schedule.id, next)
      } catch (error) {
        console.error(
          `[Sixb] Scheduler failed to compute next occurrence for '${schedule.id}':`,
          error
        )
        this.nextOccurrences.delete(schedule.id)
      }
    }

    this.armTimer()
  }

  /** Keep in-flight emits awaitable so `stop()` does not return mid-delivery. */
  private track(emit: Promise<void>): void {
    const tracked = emit.finally(() => this.pendingEmits.delete(tracked))
    this.pendingEmits.add(tracked)
  }
}

function isCronSchedule(schedule: ScheduleDefinition): schedule is CronScheduleDefinition {
  return schedule.trigger.type === "cron"
}
