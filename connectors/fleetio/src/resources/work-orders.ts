import type { FleetioHttp } from "../http"
import type {
  FleetioWorkOrder,
  FleetioWorkOrderCreateInput,
  FleetioWorkOrderFilter,
  FleetioWorkOrderSort,
  FleetioWorkOrderSummary,
  FleetioWorkOrderUpdateInput,
} from "../types"
import {
  type FleetioReadMethods,
  type FleetioWriteMethods,
  readMethods,
  writeMethods,
} from "./crud"

export type WorkOrdersResource = FleetioReadMethods<
  FleetioWorkOrderSummary,
  FleetioWorkOrder,
  FleetioWorkOrderFilter,
  FleetioWorkOrderSort
> &
  FleetioWriteMethods<
    FleetioWorkOrderCreateInput,
    FleetioWorkOrder,
    FleetioWorkOrderUpdateInput,
    FleetioWorkOrder
  >

export function workOrdersResource(http: FleetioHttp): WorkOrdersResource {
  return {
    ...readMethods(http, "work_orders", "work order id"),
    ...writeMethods(http, "work_orders", "work order id"),
  }
}
