import { resolveRuntimeAuthorizationForProject } from "../execution/authorization"
import type { DefinitionCatalog } from "../runtime/definitions"
import type { SixbRuntimeContext } from "../runtime/types"
import type { ScheduleDefinition } from "./types"

/** Schedule definitions visible to an execution; process lifecycle remains on the host. */
export type SchedulesRuntime = DefinitionCatalog<ScheduleDefinition>

export function createSchedulesRuntime(
  runtime: SixbRuntimeContext,
  schedules: DefinitionCatalog<ScheduleDefinition>
): SchedulesRuntime {
  const authority = resolveRuntimeAuthorizationForProject(runtime)
  return {
    list: () => {
      switch (authority.type) {
        case "denied":
        case "delegated":
          return []
        case "principal":
        case "unrestricted":
          return schedules.list()
      }
    },
    getById: (scheduleId) => {
      switch (authority.type) {
        case "denied":
        case "delegated":
          return null
        case "principal":
        case "unrestricted":
          return schedules.getById(scheduleId)
      }
    },
  }
}
