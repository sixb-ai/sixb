import type { DomainEventLog } from "../events"
import type { CronScheduleDefinition, ScheduleDefinition } from "../schedules"
import { nextCronOccurrence } from "../schedules"
import { SchedulerValidationError } from "./errors"

export interface SchedulerRuntimeOptions {
  schedules: readonly ScheduleDefinition[]
  events: DomainEventLog
  now?: () => Date
}

export class SchedulerRuntime {
  private readonly schedules: readonly CronScheduleDefinition[]
  private readonly events: DomainEventLog
  private readonly now: () => Date
  private started = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly nextOccurrences = new Map<string, Date>()

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
      try {
        const occurrenceAtIso = occurrenceAt.toISOString()
        void this.events.append({
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
        })
      } catch (error) {
        console.error(
          `[Sixb] Scheduler failed to emit schedule.triggered for '${schedule.id}':`,
          error
        )
      }

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
}

function isCronSchedule(schedule: ScheduleDefinition): schedule is CronScheduleDefinition {
  return schedule.trigger.type === "cron"
}
