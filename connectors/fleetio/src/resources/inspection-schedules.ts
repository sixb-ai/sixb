import type { FleetioHttp } from "../http"
import type {
  FleetioId,
  FleetioInspectionSchedule,
  FleetioInspectionScheduleFilter,
  FleetioInspectionScheduleSort,
  FleetioInspectionScheduleSummary,
} from "../types"
import { pathId } from "../validation"
import { type FleetioListMethods, listMethods } from "./crud"

export interface FleetioInspectionScheduleGetOptions {
  /** Number of `upcoming_occurrences` to return with the schedule. */
  readonly includeOccurrences?: number
}

export type InspectionSchedulesResource = FleetioListMethods<
  FleetioInspectionScheduleSummary,
  FleetioInspectionScheduleFilter,
  FleetioInspectionScheduleSort
> & {
  get(
    id: FleetioId,
    options?: FleetioInspectionScheduleGetOptions
  ): Promise<FleetioInspectionSchedule>
}

export function inspectionSchedulesResource(http: FleetioHttp): InspectionSchedulesResource {
  return {
    ...listMethods(http, "inspection_schedules"),
    get(id, options) {
      return http.get(`inspection_schedules/${pathId(id, "inspection schedule id")}`, {
        include_occurrences: options?.includeOccurrences,
      })
    },
  }
}
