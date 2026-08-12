import type { DefinitionCatalog } from "../runtime/definitions"
import type { ScheduleDefinition } from "./types"

/** Schedule definitions visible to an execution; process lifecycle remains on the host. */
export type SchedulesRuntime = DefinitionCatalog<ScheduleDefinition>

export function createSchedulesRuntime(
  schedules: DefinitionCatalog<ScheduleDefinition>
): SchedulesRuntime {
  return {
    list: () => schedules.list(),
    getById: (scheduleId) => schedules.getById(scheduleId),
  }
}
