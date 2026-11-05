import type { FleetioHttp } from "./http"
import { commentsResource } from "./resources/comments"
import { contactsResource } from "./resources/contacts"
import { customFieldsResource } from "./resources/custom-fields"
import { equipmentResource } from "./resources/equipment"
import { equipmentStatusesResource } from "./resources/equipment-statuses"
import { equipmentTypesResource } from "./resources/equipment-types"
import { groupsResource } from "./resources/groups"
import { issuePrioritiesResource } from "./resources/issue-priorities"
import { issuesResource } from "./resources/issues"
import { labelsResource } from "./resources/labels"
import { serviceEntriesResource } from "./resources/service-entries"
import { serviceEntryLineItemsResource } from "./resources/service-entry-line-items"
import { serviceRemindersResource } from "./resources/service-reminders"
import { serviceTasksResource } from "./resources/service-tasks"
import { vehicleAssignmentsResource } from "./resources/vehicle-assignments"
import { vehicleStatusesResource } from "./resources/vehicle-statuses"
import { vehicleTypesResource } from "./resources/vehicle-types"
import { vehiclesResource } from "./resources/vehicles"
import { vendorsResource } from "./resources/vendors"
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
    vehicles: vehiclesResource(http),
    vehicleStatuses: vehicleStatusesResource(http),
    vehicleTypes: vehicleTypesResource(http),
    vehicleAssignments: vehicleAssignmentsResource(http),
    contacts: contactsResource(http),
    vendors: vendorsResource(http),
    groups: groupsResource(http),
    equipment: equipmentResource(http),
    equipmentStatuses: equipmentStatusesResource(http),
    equipmentTypes: equipmentTypesResource(http),
  }
}
