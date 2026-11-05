import type { FleetioHttp } from "../http"
import type {
  FleetioEquipmentStatus,
  FleetioEquipmentStatusFilter,
  FleetioEquipmentStatusSort,
} from "../types"
import { type FleetioReadMethods, readMethods } from "./crud"

export type EquipmentStatusesResource = FleetioReadMethods<
  FleetioEquipmentStatus,
  FleetioEquipmentStatus,
  FleetioEquipmentStatusFilter,
  FleetioEquipmentStatusSort
>

export function equipmentStatusesResource(http: FleetioHttp): EquipmentStatusesResource {
  return readMethods(http, "equipment_statuses", "equipment status id")
}
