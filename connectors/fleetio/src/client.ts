import type { FleetioHttp } from "./http"
import { commentsResource } from "./resources/comments"
import { contactsResource } from "./resources/contacts"
import { customFieldsResource } from "./resources/custom-fields"
import { equipmentResource } from "./resources/equipment"
import { equipmentStatusesResource } from "./resources/equipment-statuses"
import { equipmentTypesResource } from "./resources/equipment-types"
import { expenseEntriesResource } from "./resources/expense-entries"
import { expenseEntryTypesResource } from "./resources/expense-entry-types"
import { faultsResource } from "./resources/faults"
import { fuelEntriesResource } from "./resources/fuel-entries"
import { fuelTypesResource } from "./resources/fuel-types"
import { groupsResource } from "./resources/groups"
import { inspectionFormsResource } from "./resources/inspection-forms"
import { inspectionSchedulesResource } from "./resources/inspection-schedules"
import { inventoryAdjustmentReasonsResource } from "./resources/inventory-adjustment-reasons"
import { inventoryJournalEntriesResource } from "./resources/inventory-journal-entries"
import { issuePrioritiesResource } from "./resources/issue-priorities"
import { issuesResource } from "./resources/issues"
import { labelsResource } from "./resources/labels"
import { meterEntriesResource } from "./resources/meter-entries"
import { partLocationDetailsResource } from "./resources/part-location-details"
import { partLocationsResource } from "./resources/part-locations"
import { partsResource } from "./resources/parts"
import { purchaseOrderLineItemsResource } from "./resources/purchase-order-line-items"
import { purchaseOrdersResource } from "./resources/purchase-orders"
import { serviceEntriesResource } from "./resources/service-entries"
import { serviceEntryLineItemsResource } from "./resources/service-entry-line-items"
import { serviceRemindersResource } from "./resources/service-reminders"
import { serviceTasksResource } from "./resources/service-tasks"
import { submittedInspectionFormsResource } from "./resources/submitted-inspection-forms"
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
    parts: partsResource(http),
    partLocations: partLocationsResource(http),
    partLocationDetails: partLocationDetailsResource(http),
    inventoryJournalEntries: inventoryJournalEntriesResource(http),
    inventoryAdjustmentReasons: inventoryAdjustmentReasonsResource(http),
    purchaseOrders: purchaseOrdersResource(http),
    purchaseOrderLineItems: purchaseOrderLineItemsResource(http),
    meterEntries: meterEntriesResource(http),
    fuelEntries: fuelEntriesResource(http),
    fuelTypes: fuelTypesResource(http),
    expenseEntries: expenseEntriesResource(http),
    expenseEntryTypes: expenseEntryTypesResource(http),
    faults: faultsResource(http),
    inspectionForms: inspectionFormsResource(http),
    submittedInspectionForms: submittedInspectionFormsResource(http),
    inspectionSchedules: inspectionSchedulesResource(http),
  }
}
