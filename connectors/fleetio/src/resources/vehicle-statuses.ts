import type { FleetioHttp } from "../http"
import type {
  FleetioVehicleStatus,
  FleetioVehicleStatusCreateInput,
  FleetioVehicleStatusFilter,
  FleetioVehicleStatusSort,
  FleetioVehicleStatusUpdateInput,
} from "../types"
import {
  type FleetioReadMethods,
  type FleetioWriteMethods,
  readMethods,
  writeMethods,
} from "./crud"

export type VehicleStatusesResource = FleetioReadMethods<
  FleetioVehicleStatus,
  FleetioVehicleStatus,
  FleetioVehicleStatusFilter,
  FleetioVehicleStatusSort
> &
  FleetioWriteMethods<
    FleetioVehicleStatusCreateInput,
    FleetioVehicleStatus,
    FleetioVehicleStatusUpdateInput
  >

export function vehicleStatusesResource(http: FleetioHttp): VehicleStatusesResource {
  return {
    ...readMethods(http, "vehicle_statuses", "vehicle status id"),
    ...writeMethods(http, "vehicle_statuses", "vehicle status id"),
  }
}
