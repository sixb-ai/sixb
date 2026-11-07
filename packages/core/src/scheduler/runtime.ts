import type { DomainEventLog } from "../events"
import { MaintenanceLoop, type MaintenancePass } from "../maintenance/loop"
import type { CronScheduleDefinition, ScheduleDefinition } from "../schedules/types"
import { CronPass } from "./cron-pass"
import { SchedulerValidationError } from "./errors"

export interface SchedulerRuntimeOptions {
  schedules: readonly ScheduleDefinition[]
  events: DomainEventLog
  /** Evaluates cron schedules that set no time zone of their own. Defaults to UTC. */
  timeZone?: string
  now?: () => Date
}

/** Process lifecycle surface exposed by SixbHost. */
export interface SchedulerController {
  start(): Promise<void>
  stop(): Promise<void>
}

/**
 * The project's cron schedules. The orchestrator runs `pass` on its maintenance loop; `start()`
 * runs it on a loop of its own, for an embedded host with no orchestrator.
 */
export class SchedulerRuntime implements SchedulerController {
  private readonly cron: CronPass
  private readonly schedules: readonly CronScheduleDefinition[]
  private readonly loop: MaintenanceLoop
  private started = false

  constructor(options: SchedulerRuntimeOptions) {
    this.schedules = options.schedules.filter(isCronSchedule)
    const now = options.now ?? (() => new Date())

    this.cron = new CronPass({
      schedules: this.schedules,
      events: options.events,
      // `undefined` keeps the arithmetic UTC path; an explicit "UTC" would go through Intl.
      timeZone: options.timeZone === "UTC" ? undefined : options.timeZone,
      now,
    })
    this.loop = new MaintenanceLoop({
      passes: [this.cron],
      onError: (error) => console.error("[Sixb] Scheduler error:", error),
      now,
    })
  }

  get pass(): MaintenancePass {
    return this.cron
  }

  async start(): Promise<void> {
    if (this.started) return

    assertUniqueScheduleIds(this.schedules)
    this.loop.start()
    this.started = true
  }

  async stop(): Promise<void> {
    await this.loop.stop()

    this.cron.reset()
    this.started = false
    await this.cron.drainEmits()
  }
}

function assertUniqueScheduleIds(schedules: readonly CronScheduleDefinition[]): void {
  const seen = new Set<string>()

  for (const schedule of schedules) {
    if (seen.has(schedule.id)) {
      throw new SchedulerValidationError(`Duplicate schedule id '${schedule.id}'.`)
    }
    seen.add(schedule.id)
  }
}

function isCronSchedule(schedule: ScheduleDefinition): schedule is CronScheduleDefinition {
  return schedule.trigger.type === "cron"
}
