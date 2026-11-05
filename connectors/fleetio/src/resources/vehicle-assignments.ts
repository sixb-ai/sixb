import type { FleetioHttp } from "../http"
import type {
  FleetioId,
  FleetioVehicleAssignment,
  FleetioVehicleAssignmentCreateInput,
  FleetioVehicleAssignmentFilter,
  FleetioVehicleAssignmentSort,
  FleetioVehicleAssignmentSummary,
  FleetioVehicleAssignmentUpdateInput,
} from "../types"
import { pathId } from "../validation"
import {
  type FleetioReadMethods,
  type FleetioWriteMethods,
  readMethods,
  writeMethods,
} from "./crud"

export type VehicleAssignmentsResource = FleetioReadMethods<
  FleetioVehicleAssignmentSummary,
  FleetioVehicleAssignment,
  FleetioVehicleAssignmentFilter,
  FleetioVehicleAssignmentSort
> &
  FleetioWriteMethods<
    FleetioVehicleAssignmentCreateInput,
    FleetioVehicleAssignment,
    FleetioVehicleAssignmentUpdateInput,
    FleetioVehicleAssignment
  > & {
    /** `PATCH /vehicle_assignments/{id}/unassign` */
    unassign(id: FleetioId): Promise<FleetioVehicleAssignment>
  }

export function vehicleAssignmentsResource(http: FleetioHttp): VehicleAssignmentsResource {
  return {
    ...readMethods(http, "vehicle_assignments", "vehicle assignment id"),
    ...writeMethods(http, "vehicle_assignments", "vehicle assignment id"),
    unassign(id) {
      return http.patch(`vehicle_assignments/${pathId(id, "vehicle assignment id")}/unassign`)
    },
  }
}
