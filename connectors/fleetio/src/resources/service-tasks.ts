import type { FleetioHttp } from "../http"
import type {
  FleetioId,
  FleetioServiceTask,
  FleetioServiceTaskCreated,
  FleetioServiceTaskCreateInput,
  FleetioServiceTaskFilter,
  FleetioServiceTaskSort,
  FleetioServiceTaskSummary,
  FleetioServiceTaskUpdateInput,
} from "../types"
import { pathId } from "../validation"
import {
  type FleetioListMethods,
  type FleetioWriteMethods,
  listMethods,
  writeMethods,
} from "./crud"

export interface FleetioServiceTaskGetOptions {
  /** Additional attributes to return with the task. Fleetio accepts `service_task_parts`. */
  readonly expand?: { readonly service_task_parts?: string }
}

export type ServiceTasksResource = FleetioListMethods<
  FleetioServiceTaskSummary,
  FleetioServiceTaskFilter,
  FleetioServiceTaskSort
> &
  FleetioWriteMethods<
    FleetioServiceTaskCreateInput,
    FleetioServiceTaskCreated,
    FleetioServiceTaskUpdateInput
  > & {
    get(id: FleetioId, options?: FleetioServiceTaskGetOptions): Promise<FleetioServiceTask>
  }

export function serviceTasksResource(http: FleetioHttp): ServiceTasksResource {
  return {
    ...listMethods(http, "service_tasks"),
    ...writeMethods(http, "service_tasks", "service task id"),
    get(id, options) {
      return http.get(`service_tasks/${pathId(id, "service task id")}`, {
        "expand[service_task_parts]": options?.expand?.service_task_parts,
      })
    },
  }
}
