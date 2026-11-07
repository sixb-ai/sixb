import type { DomainEventLog } from "../events"
import type { MaintenancePass } from "../maintenance/loop"
import { nextCronOccurrence } from "../schedules/next-occurrence"
import type { CronScheduleDefinition } from "../schedules/types"

/** Matches the `onError` flush budget: long enough for a healthy broker, short enough to shut down. */
const EMIT_BUDGET_MS = 5_000

export interface CronPassOptions {
  readonly schedules: readonly CronScheduleDefinition[]
  readonly events: DomainEventLog
  /** Evaluates cron schedules that set no time zone of their own. Undefined means UTC. */
  readonly timeZone: string | undefined
  readonly now: () => Date
}

/**
 * Emits `schedule.triggered` for each cron occurrence, on the second it falls due. The next
 * occurrences live in memory, counted from the moment the pass starts: an occurrence that falls
 * while nothing runs this pass is not caught up.
 */
export class CronPass implements MaintenancePass {
  readonly id = "cron"
  readonly budgetMs = EMIT_BUDGET_MS
  private nextOccurrences: Map<string, Date> | null = null
  private readonly pendingEmits = new Set<Promise<void>>()

  constructor(private readonly options: CronPassOptions) {}

  nextRunAt(now: Date): Date | null {
    this.nextOccurrences ??= this.firstOccurrences(now)

    const times = [...this.nextOccurrences.values()].map((date) => date.getTime())
    return times.length > 0 ? new Date(Math.min(...times)) : null
  }

  /**
   * `emit` never rejects, and an emit that never settles must not hold the next occurrence, so a
   * run waits for its emits only until its budget ends. They stay tracked for `drainEmits()`.
   */
  async run(signal: AbortSignal): Promise<void> {
    const emits = this.emitDue(this.options.now())

    await Promise.race([Promise.all(emits), aborted(signal)])
  }

  /** Forgets the next occurrences, so a later start counts them from then. */
  reset(): void {
    this.nextOccurrences = null
  }

  /**
   * Waits for in-flight emits so shutdown does not return mid-delivery. Bounded on purpose: an emit
   * that never settles would turn a provider stall into a process that cannot shut down. Losing the
   * wait is recoverable; losing shutdown is not.
   */
  async drainEmits(timeoutMs = EMIT_BUDGET_MS): Promise<void> {
    if (this.pendingEmits.size === 0) return

    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs)
    })

    const drained = await Promise.race([Promise.all(this.pendingEmits).then(() => true), timedOut])
    clearTimeout(timer)

    if (!drained) {
      console.error(
        `[Sixb] Timed out after ${timeoutMs}ms waiting for ${this.pendingEmits.size} schedule emit(s) to settle.`
      )
    }
  }

  private firstOccurrences(now: Date): Map<string, Date> {
    const occurrences = new Map<string, Date>()

    for (const schedule of this.options.schedules) {
      const next = this.occurrenceAfter(schedule, now)
      if (next) occurrences.set(schedule.id, next)
    }

    return occurrences
  }

  private emitDue(now: Date): readonly Promise<void>[] {
    const emits: Promise<void>[] = []

    for (const schedule of this.options.schedules) {
      let occurrence = this.nextOccurrences?.get(schedule.id)

      while (occurrence && occurrence <= now) {
        emits.push(this.emitOccurrence(schedule, occurrence, now))
        occurrence = this.advance(schedule, occurrence)
      }
    }

    return emits
  }

  /** `emit` reports instead of rejecting, so a broker outage reaches `onError`, not nowhere. */
  private emitOccurrence(
    schedule: CronScheduleDefinition,
    occurrenceAt: Date,
    now: Date
  ): Promise<void> {
    const occurrenceAtIso = occurrenceAt.toISOString()

    const emit = this.options.events.emit(
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

    const tracked = emit.finally(() => this.pendingEmits.delete(tracked))
    this.pendingEmits.add(tracked)
    return tracked
  }

  /** Counts from the occurrence, not from now, so a late wake-up drifts nothing. */
  private advance(schedule: CronScheduleDefinition, occurrence: Date): Date | undefined {
    const next = this.occurrenceAfter(schedule, occurrence)

    if (next) this.nextOccurrences?.set(schedule.id, next)
    else this.nextOccurrences?.delete(schedule.id)

    return next
  }

  /**
   * A valid expression can still have no reachable occurrence: `0 0 30 2 *` parses but never
   * matches. That stops this one schedule, never the others.
   */
  private occurrenceAfter(schedule: CronScheduleDefinition, after: Date): Date | undefined {
    try {
      return nextCronOccurrence(
        schedule.trigger.expression,
        after,
        schedule.trigger.timezone ?? this.options.timeZone
      )
    } catch (error) {
      console.error(
        `[Sixb] Scheduler failed to compute next occurrence for '${schedule.id}':`,
        error
      )
      return undefined
    }
  }
}

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener("abort", () => resolve(), { once: true })
  })
}
