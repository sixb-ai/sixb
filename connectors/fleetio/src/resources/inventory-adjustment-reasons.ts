import type { FleetioHttp } from "../http"
import type {
  FleetioInventoryAdjustmentReason,
  FleetioInventoryAdjustmentReasonFilter,
  FleetioInventoryAdjustmentReasonSort,
} from "../types"
import { type FleetioListMethods, listMethods } from "./crud"

export type InventoryAdjustmentReasonsResource = FleetioListMethods<
  FleetioInventoryAdjustmentReason,
  FleetioInventoryAdjustmentReasonFilter,
  FleetioInventoryAdjustmentReasonSort
>

export function inventoryAdjustmentReasonsResource(
  http: FleetioHttp
): InventoryAdjustmentReasonsResource {
  return listMethods(http, "inventory_adjustment_reasons")
}
