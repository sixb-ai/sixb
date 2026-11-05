import type { FleetioHttp } from "../http"
import type {
  FleetioPurchaseOrderLineItem,
  FleetioPurchaseOrderLineItemCreated,
  FleetioPurchaseOrderLineItemCreateInput,
  FleetioPurchaseOrderLineItemSort,
  FleetioPurchaseOrderLineItemUpdateInput,
} from "../types"
import { type FleetioNestedMethods, nestedMethods } from "./crud"

/** Line items of a purchase order. Every method takes the purchase order's `number` first. */
export type PurchaseOrderLineItemsResource = FleetioNestedMethods<
  FleetioPurchaseOrderLineItem,
  FleetioPurchaseOrderLineItem,
  FleetioPurchaseOrderLineItemCreateInput,
  FleetioPurchaseOrderLineItemCreated,
  FleetioPurchaseOrderLineItemUpdateInput,
  void,
  FleetioPurchaseOrderLineItemSort
>

export function purchaseOrderLineItemsResource(http: FleetioHttp): PurchaseOrderLineItemsResource {
  return nestedMethods(
    http,
    "purchase_orders",
    "purchase order number",
    "purchase_order_line_items",
    "line item id"
  )
}
