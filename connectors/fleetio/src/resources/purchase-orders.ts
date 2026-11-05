import type { FleetioHttp } from "../http"
import type {
  FleetioId,
  FleetioPurchaseOrder,
  FleetioPurchaseOrderCreated,
  FleetioPurchaseOrderCreateInput,
  FleetioPurchaseOrderFilter,
  FleetioPurchaseOrderSort,
  FleetioPurchaseOrderSummary,
  FleetioPurchaseOrderUpdateInput,
} from "../types"
import { pathId } from "../validation"
import {
  type FleetioReadMethods,
  type FleetioWriteMethods,
  readMethods,
  writeMethods,
} from "./crud"

/** Purchase orders. Fleetio addresses them by their `number`, not their `id`. */
export type PurchaseOrdersResource = FleetioReadMethods<
  FleetioPurchaseOrderSummary,
  FleetioPurchaseOrder,
  FleetioPurchaseOrderFilter,
  FleetioPurchaseOrderSort
> &
  FleetioWriteMethods<
    FleetioPurchaseOrderCreateInput,
    FleetioPurchaseOrderCreated,
    FleetioPurchaseOrderUpdateInput
  > & {
    /** `PATCH /purchase_orders/{number}/submit_for_approval` */
    submitForApproval(number: FleetioId): Promise<void>
    /** `PATCH /purchase_orders/{number}/approve` */
    approve(number: FleetioId): Promise<void>
    /** `PATCH /purchase_orders/{number}/reject` */
    reject(number: FleetioId): Promise<void>
    /** `PATCH /purchase_orders/{number}/purchase` */
    purchase(number: FleetioId): Promise<void>
    /** `PATCH /purchase_orders/{number}/undo_purchase` */
    undoPurchase(number: FleetioId): Promise<void>
    /** `PATCH /purchase_orders/{number}/close` */
    close(number: FleetioId): Promise<void>
  }

export function purchaseOrdersResource(http: FleetioHttp): PurchaseOrdersResource {
  const action = (number: FleetioId, name: string) =>
    http.patch<void>(`purchase_orders/${pathId(number, "purchase order number")}/${name}`)

  return {
    ...readMethods(http, "purchase_orders", "purchase order number"),
    ...writeMethods(http, "purchase_orders", "purchase order number"),
    submitForApproval: (number) => action(number, "submit_for_approval"),
    approve: (number) => action(number, "approve"),
    reject: (number) => action(number, "reject"),
    purchase: (number) => action(number, "purchase"),
    undoPurchase: (number) => action(number, "undo_purchase"),
    close: (number) => action(number, "close"),
  }
}
