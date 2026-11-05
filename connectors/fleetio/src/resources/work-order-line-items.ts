import type { FleetioHttp } from "../http"
import type {
  FleetioWorkOrderLineItem,
  FleetioWorkOrderLineItemCreated,
  FleetioWorkOrderLineItemCreateInput,
  FleetioWorkOrderLineItemSort,
  FleetioWorkOrderLineItemUpdateInput,
} from "../types"
import { type FleetioNestedMethods, nestedMethods } from "./crud"

/** Line items of a work order. Every method takes the work order's ID first. */
export type WorkOrderLineItemsResource = FleetioNestedMethods<
  FleetioWorkOrderLineItem,
  FleetioWorkOrderLineItem,
  FleetioWorkOrderLineItemCreateInput,
  FleetioWorkOrderLineItemCreated,
  FleetioWorkOrderLineItemUpdateInput,
  void,
  FleetioWorkOrderLineItemSort
>

export function workOrderLineItemsResource(http: FleetioHttp): WorkOrderLineItemsResource {
  return nestedMethods(
    http,
    "work_orders",
    "work order id",
    "work_order_line_items",
    "line item id"
  )
}
