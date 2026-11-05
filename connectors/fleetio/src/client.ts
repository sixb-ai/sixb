import type { FleetioHttp } from "./http"
import { vmrsReasonsForRepairResource } from "./resources/vmrs-reasons-for-repair"
import { workOrderLineItemsResource } from "./resources/work-order-line-items"
import { workOrderStatusesResource } from "./resources/work-order-statuses"
import { workOrdersResource } from "./resources/work-orders"
import type { FleetioClient } from "./types"

export function createFleetioClient(http: FleetioHttp): FleetioClient {
  return {
    workOrders: workOrdersResource(http),
    workOrderLineItems: workOrderLineItemsResource(http),
    workOrderStatuses: workOrderStatusesResource(http),
    vmrsReasonsForRepair: vmrsReasonsForRepairResource(http),
  }
}
