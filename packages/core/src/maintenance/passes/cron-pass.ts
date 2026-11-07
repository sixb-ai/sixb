import type { DomainEventLog } from "../events"
import type { MaintenancePass } from "../maintenance/loop"
import { nextCronOccurrence } from "../schedules/next-occurrence"
import type { CronScheduleDefinition } from "../schedules/types"

/** Matches the `onError` flush budget: long enough for a healthy broker, short enough to shut down. */
const APPEND_BUDGET_MS = 5_000

/** How long an occurrence the broker refused waits for its next try. */
const RETRY_DELAY_MS = 10_000

export interface CronPassOptions {
  readonly schedules: readonly CronScheduleDefinition[]
  readonly events: DomainEventLog
  /** Evaluates cron schedules that set no time zone of their own. Undefined means UTC. */
  readonly timeZone: string | undefined
  readonly now: () => Date
}

interface NextOccurrence {
  readonly at: Date
  /** Set once the broker refused this occurrence: it is then due at this time instead. */
  retryAt: Date | null
}

/**
 * Appends `schedule.triggered` for each cron occurrence, on the second it falls due. The next
 * occurrences live in memory, counted from the moment the pass starts: one that falls while nothing
 * runs this pass is not caught up.
 *
 * An occurrence the broker refuses stays the one in hand and is tried again, which fails the pass
 * until the broker accepts it. Its occurrence key makes that safe. The occurrences that fell
 * meanwhile are not caught up: the next one counts from the moment it went through.
 */
export class CronPass implements MaintenancePass {
  readonly id = "cron"
  readonly budgetMs = APPEND_BUDGET_MS
  private occurrences: Map<string, NextOccurrence> | null = null
  private readonly pendingAppends = new Set<Promise<void>>()

  constructor(private readonly options: CronPassOptions) {}

  nextRunAt(now: Date): Date | null {
    this.occurrences ??= this.firstOccurrences(now)

    const times = [...this.occurrences.values()].map((next) => dueAt(next).getTime())
    return times.length > 0 ? new Date(Math.min(...times)) : null
  }

  /** Each schedule fires on its own, so one that fails costs the others nothing. */
  async run(signal: AbortSignal): Promise<void> {
    const now = this.options.now()

    const results = await Promise.allSettled(
      this.options.schedules.map((schedule) => this.fireDue(schedule, now, signal))
    )

    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    )
    if (failures.length > 0) {
      throw new AggregateError(failures, "[Sixb] The broker refused a cron occurrence.")
    }
  }

  /** Forgets the next occurrences, so a later start counts them from then. */
  reset(): void {
    this.occurrences = null
  }

  /**
   * Waits for appends a run stopped waiting for, so shutdown does not return mid-delivery. Bounded
   * on purpose: an append that never settles would turn a provider stall into a process that cannot
   * shut down. Losing the wait is recoverable; losing shutdown is not.
   */
  async drainAppends(timeoutMs = APPEND_BUDGET_MS): Promise<void> {
    if (this.pendingAppends.size === 0) return

    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs)
    })

    const drained = await Promise.race([
      Promise.all(this.pendingAppends).then(() => true),
      timedOut,
    ])
    clearTimeout(timer)

    if (!drained) {
      console.error(
        `[Sixb] Timed out after ${timeoutMs}ms waiting for ${this.pendingAppends.size} schedule append(s) to settle.`
      )
    }
  }

  private firstOccurrences(now: Date): Map<string, NextOccurrence> {
    const occurrences = new Map<string, NextOccurrence>()

    for (const schedule of this.options.schedules) {
      const at = this.occurrenceAfter(schedule, now)
      if (at) occurrences.set(schedule.id, { at, retryAt: null })
    }

    return occurrences
  }

  private async fireDue(
    schedule: CronScheduleDefinition,
    now: Date,
    signal: AbortSignal
  ): Promise<void> {
    let next = this.occurrences?.get(schedule.id)

    while (next && dueAt(next) <= now) {
      try {
        await this.appendOccurrence(schedule, next.at, now, signal)
      } catch (error) {
        next.retryAt = new Date(this.options.now().getTime() + RETRY_DELAY_MS)
        throw error
      }

      next = this.advance(schedule, next, now)
    }
  }

  /**
   * An append that hangs must not hold the pass past its budget, so this stops waiting when the
   * signal aborts. The append stays tracked for `drainAppends()`, and the retry that follows
   * carries the same key.
   */
  private async appendOccurrence(
    schedule: CronScheduleDefinition,
    occurrenceAt: Date,
    now: Date,
    signal: AbortSignal
  ): Promise<void> {
    const occurrenceAtIso = occurrenceAt.toISOString()
    const occurrenceKey = `${schedule.id}:${occurrenceAtIso}`

    const append = this.options.events.append({
      events: [
        {
          type: "schedule.triggered",
          // A retry, or a second orchestrator, stores one event, so one run starts.
          idempotencyKey: occurrenceKey,
          payload: {
            scheduleId: schedule.id,
            occurrenceAt: occurrenceAtIso,
            triggeredAt: now.toISOString(),
            occurrenceKey,
          },
        },
      ],
    })

    const settled = append.then(
      () => {},
      () => {}
    )
    const tracked = settled.finally(() => this.pendingAppends.delete(tracked))
    this.pendingAppends.add(tracked)

    await Promise.race([append, aborted(signal)])
  }

  /**
   * Counts from the occurrence, not from now, so a late wake-up drifts nothing. One that had to be
   * retried counts from now instead: what fell during the outage stays lost.
   */
  private advance(
    schedule: CronScheduleDefinition,
    done: NextOccurrence,
    now: Date
  ): NextOccurrence | undefined {
    const at = this.occurrenceAfter(schedule, done.retryAt ? now : done.at)
    const next = at ? { at, retryAt: null } : undefined

    if (next) this.occurrences?.set(schedule.id, next)
    else this.occurrences?.delete(schedule.id)

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

function dueAt(next: NextOccurrence): Date {
  return next.retryAt ?? next.at
}

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true })
  })
}
