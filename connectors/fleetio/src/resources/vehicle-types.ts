import type { FleetioHttp } from "../http"
import type {
  FleetioVehicleType,
  FleetioVehicleTypeCreateInput,
  FleetioVehicleTypeFilter,
  FleetioVehicleTypeSort,
  FleetioVehicleTypeUpdateInput,
} from "../types"
import {
  type FleetioReadMethods,
  type FleetioWriteMethods,
  readMethods,
  writeMethods,
} from "./crud"

export type VehicleTypesResource = FleetioReadMethods<
  FleetioVehicleType,
  FleetioVehicleType,
  FleetioVehicleTypeFilter,
  FleetioVehicleTypeSort
> &
  FleetioWriteMethods<
    FleetioVehicleTypeCreateInput,
    FleetioVehicleType,
    FleetioVehicleTypeUpdateInput
  >

export function vehicleTypesResource(http: FleetioHttp): VehicleTypesResource {
  return {
    ...readMethods(http, "vehicle_types", "vehicle type id"),
    ...writeMethods(http, "vehicle_types", "vehicle type id"),
  }
}
