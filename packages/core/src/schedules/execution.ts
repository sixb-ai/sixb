import type { SchedulesRuntime } from "./runtime"

/** Schedule definitions visible to an execution; process lifecycle remains on the host. */
export type ExecutionSchedulesRuntime = Pick<SchedulesRuntime, "list" | "getById">

export function createExecutionSchedulesRuntime(
  schedules: SchedulesRuntime
): ExecutionSchedulesRuntime {
  return {
    list: () => schedules.list(),
    getById: (scheduleId) => schedules.getById(scheduleId),
  }
}
