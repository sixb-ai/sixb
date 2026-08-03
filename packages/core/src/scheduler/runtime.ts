import { SixbError } from "../errors"
import type { DomainEventLog } from "../events"
import type { CronScheduleDefinition, ScheduleDefinition } from "../schedules"
import { nextCronOccurrence } from "../schedules"

/** Matches the `onError` flush budget: long enough for a healthy broker, short enough to shut down. */
const DEFAULT_EMIT_DRAIN_TIMEOUT_MS = 5_000

export interface SchedulerRuntimeOptions {
  schedules: readonly ScheduleDefinition[]
  events: DomainEventLog
  now?: () => Date
  /**
   * Where a schedule that can no longer be planned is escalated.
   *
   * A runtime fills this with the escalation channel; the fallback is the standalone path — a
   * scheduler constructed directly, which is a test or an embedding, not a running project.
   */
  onError?: (error: unknown, scheduleId: string) => void
}

export class SchedulerRuntime {
  private readonly schedules: readonly CronScheduleDefinition[]
  private readonly events: DomainEventLog
  private readonly now: () => Date
  private readonly onError: (error: unknown, scheduleId: string) => void
  private started = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly nextOccurrences = new Map<string, Date>()
  private readonly pendingEmits = new Set<Promise<void>>()

  constructor(options: SchedulerRuntimeOptions) {
    this.schedules = options.schedules.filter(isCronSchedule)
    this.events = options.events
    this.now = options.now ?? (() => new Date())
    this.onError =
      options.onError ??
      ((error, scheduleId) =>
        console.error(
          `[Sixb] Scheduler failed to compute next occurrence for '${scheduleId}':`,
          error
        ))
  }

  async start(): Promise<void> {
    if (this.started) return

    const seenIds = new Set<string>()
    for (const schedule of this.schedules) {
      if (seenIds.has(schedule.id)) {
        throw new SixbError("runtime.invalid_definition", `Duplicate schedule id '${schedule.id}'.`)
      }
      seenIds.add(schedule.id)
    }

    const now = this.now()
    for (const schedule of this.schedules) {
      const next = nextCronOccurrence(schedule.trigger.expression, now, schedule.trigger.timezone)
      this.nextOccurrences.set(schedule.id, next)
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

    const delayMs = Math.max(0, earliest.getTime() - this.now().getTime())
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
        // The schedule stops firing from here on, and no run records why.
        this.onError(error, schedule.id)
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
