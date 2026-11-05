import type { VmrsReasonsForRepairResource } from "../resources/vmrs-reasons-for-repair"
import type { WorkOrderLineItemsResource } from "../resources/work-order-line-items"
import type { WorkOrderStatusesResource } from "../resources/work-order-statuses"
import type { WorkOrdersResource } from "../resources/work-orders"

/** Typed Fleetio client, grouped by resource. */
export interface FleetioClient {
  readonly workOrders: WorkOrdersResource
  readonly workOrderLineItems: WorkOrderLineItemsResource
  readonly workOrderStatuses: WorkOrderStatusesResource
  /** VMRS reason-for-repair codes, used on work order and service entry line items. */
  readonly vmrsReasonsForRepair: VmrsReasonsForRepairResource
}
