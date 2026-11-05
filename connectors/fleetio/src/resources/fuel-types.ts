import type { FleetioHttp } from "../http"
import type { FleetioFuelType, FleetioFuelTypeFilter, FleetioFuelTypeSort } from "../types"
import { type FleetioReadMethods, readMethods } from "./crud"

export type FuelTypesResource = FleetioReadMethods<
  FleetioFuelType,
  FleetioFuelType,
  FleetioFuelTypeFilter,
  FleetioFuelTypeSort
>

export function fuelTypesResource(http: FleetioHttp): FuelTypesResource {
  return readMethods(http, "fuel_types", "fuel type id")
}
