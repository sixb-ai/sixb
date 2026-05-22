// ── Trigger definitions ─────────────────────────────────────

/** Cron-based trigger. V1 supports only this trigger type. */
export interface CronScheduleTriggerDefinition {
  readonly type: "cron"
  readonly expression: string
  readonly timezone?: string
}

/**
 * Union of all supported trigger types.
 *
 * V1 only supports cron. Additional trigger types such as interval or calendar
 * may be added in later versions without breaking existing definitions.
 */
export type ScheduleTriggerDefinition = CronScheduleTriggerDefinition

// ── Schedule definition ─────────────────────────────────────

/**
 * Inert, standalone schedule definition.
 *
 * A schedule defines _when_ something should be triggered without encoding
 * _what_ should run or _how_ the trigger is evaluated at runtime.
 *
 * Schedule definitions are reusable and can be attached to multiple targets
 * such as syncs, pipelines, or workflows.
 */
export interface ScheduleDefinition {
  readonly kind: "schedule"
  readonly id: string
  readonly trigger: ScheduleTriggerDefinition
}

// ── Builder interfaces ──────────────────────────────────────

export interface CronScheduleBuilder {
  cron(expression: string, options?: { timezone?: string }): ScheduleDefinition
}

/**
 * Builder returned by `defineSchedule(id)`.
 *
 * V1 exposes only `.cron(...)`. Additional trigger methods may be added in
 * later versions by extending this interface.
 */
export interface ScheduleBuilder extends CronScheduleBuilder {}

// ── Type guard ──────────────────────────────────────────────

/** Runtime type guard for values discovered from `schedules/` modules. */
export function isScheduleDefinition(value: unknown): value is ScheduleDefinition {
  if (!isRecord(value)) return false
  return (
    value.kind === "schedule" &&
    typeof value.id === "string" &&
    isRecord(value.trigger) &&
    typeof value.trigger.type === "string"
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
