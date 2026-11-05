import type { FleetioHttp } from "./http"
import { commentsResource } from "./resources/comments"
import { customFieldsResource } from "./resources/custom-fields"
import { issuePrioritiesResource } from "./resources/issue-priorities"
import { issuesResource } from "./resources/issues"
import { labelsResource } from "./resources/labels"
import { serviceEntriesResource } from "./resources/service-entries"
import { serviceEntryLineItemsResource } from "./resources/service-entry-line-items"
import { serviceRemindersResource } from "./resources/service-reminders"
import { serviceTasksResource } from "./resources/service-tasks"
import { vmrsReasonsForRepairResource } from "./resources/vmrs-reasons-for-repair"
import { watchersResource } from "./resources/watchers"
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
    issues: issuesResource(http),
    issuePriorities: issuePrioritiesResource(http),
    serviceTasks: serviceTasksResource(http),
    serviceEntries: serviceEntriesResource(http),
    serviceEntryLineItems: serviceEntryLineItemsResource(http),
    serviceReminders: serviceRemindersResource(http),
    comments: commentsResource(http),
    labels: labelsResource(http),
    watchers: watchersResource(http),
    customFields: customFieldsResource(http),
  }
}
