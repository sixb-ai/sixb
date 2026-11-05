import type { FleetioHttp } from "../http"
import type {
  FleetioEquipment,
  FleetioEquipmentCreated,
  FleetioEquipmentCreateInput,
  FleetioEquipmentFilter,
  FleetioEquipmentSort,
  FleetioEquipmentSummary,
  FleetioEquipmentUpdateInput,
  FleetioId,
} from "../types"
import { pathId } from "../validation"
import {
  type FleetioReadMethods,
  type FleetioWriteMethods,
  readMethods,
  writeMethods,
} from "./crud"

export type EquipmentResource = FleetioReadMethods<
  FleetioEquipmentSummary,
  FleetioEquipment,
  FleetioEquipmentFilter,
  FleetioEquipmentSort
> &
  FleetioWriteMethods<
    FleetioEquipmentCreateInput,
    FleetioEquipmentCreated,
    FleetioEquipmentUpdateInput,
    FleetioEquipment
  > & {
    /** `PATCH /equipment/{id}/archive` */
    archive(id: FleetioId): Promise<void>
    /** `PATCH /equipment/{id}/restore` */
    restore(id: FleetioId): Promise<void>
  }

export function equipmentResource(http: FleetioHttp): EquipmentResource {
  const equipmentPath = (id: FleetioId) => `equipment/${pathId(id, "equipment id")}`

  return {
    ...readMethods(http, "equipment", "equipment id"),
    ...writeMethods(http, "equipment", "equipment id"),
    archive: (id) => http.patch(`${equipmentPath(id)}/archive`),
    restore: (id) => http.patch(`${equipmentPath(id)}/restore`),
  }
}
