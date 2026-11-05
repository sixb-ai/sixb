import type { CommentsResource } from "../resources/comments"
import type { CustomFieldsResource } from "../resources/custom-fields"
import type { IssuePrioritiesResource } from "../resources/issue-priorities"
import type { IssuesResource } from "../resources/issues"
import type { LabelsResource } from "../resources/labels"
import type { ServiceEntriesResource } from "../resources/service-entries"
import type { ServiceEntryLineItemsResource } from "../resources/service-entry-line-items"
import type { ServiceRemindersResource } from "../resources/service-reminders"
import type { ServiceTasksResource } from "../resources/service-tasks"
import type { VmrsReasonsForRepairResource } from "../resources/vmrs-reasons-for-repair"
import type { WatchersResource } from "../resources/watchers"
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
  readonly issues: IssuesResource
  readonly issuePriorities: IssuePrioritiesResource
  readonly serviceTasks: ServiceTasksResource
  readonly serviceEntries: ServiceEntriesResource
  /** Line items of a service entry. */
  readonly serviceEntryLineItems: ServiceEntryLineItemsResource
  readonly serviceReminders: ServiceRemindersResource
  /** Comments on a work order, issue, vehicle or other record. */
  readonly comments: CommentsResource
  readonly labels: LabelsResource
  readonly watchers: WatchersResource
  readonly customFields: CustomFieldsResource
}
