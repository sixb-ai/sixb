import type { FleetioHttp } from "../http"
import type {
  FleetioEquipmentType,
  FleetioEquipmentTypeFilter,
  FleetioEquipmentTypeSort,
} from "../types"
import { type FleetioReadMethods, readMethods } from "./crud"

export type EquipmentTypesResource = FleetioReadMethods<
  FleetioEquipmentType,
  FleetioEquipmentType,
  FleetioEquipmentTypeFilter,
  FleetioEquipmentTypeSort
>

export function equipmentTypesResource(http: FleetioHttp): EquipmentTypesResource {
  return readMethods(http, "equipment_types", "equipment type id")
}
