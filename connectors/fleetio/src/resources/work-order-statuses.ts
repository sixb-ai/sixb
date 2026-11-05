import type { FleetioHttp } from "../http"
import type {
  FleetioWorkOrderStatus,
  FleetioWorkOrderStatusFilter,
  FleetioWorkOrderStatusSort,
} from "../types"
import { type FleetioReadMethods, readMethods } from "./crud"

export type WorkOrderStatusesResource = FleetioReadMethods<
  FleetioWorkOrderStatus,
  FleetioWorkOrderStatus,
  FleetioWorkOrderStatusFilter,
  FleetioWorkOrderStatusSort
>

export function workOrderStatusesResource(http: FleetioHttp): WorkOrderStatusesResource {
  return readMethods(http, "work_order_statuses", "work order status id")
}
