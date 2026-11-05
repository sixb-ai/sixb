import type { CommentsResource } from "../resources/comments"
import type { ContactsResource } from "../resources/contacts"
import type { CustomFieldsResource } from "../resources/custom-fields"
import type { EquipmentResource } from "../resources/equipment"
import type { EquipmentStatusesResource } from "../resources/equipment-statuses"
import type { EquipmentTypesResource } from "../resources/equipment-types"
import type { ExpenseEntriesResource } from "../resources/expense-entries"
import type { ExpenseEntryTypesResource } from "../resources/expense-entry-types"
import type { FaultsResource } from "../resources/faults"
import type { FuelEntriesResource } from "../resources/fuel-entries"
import type { FuelTypesResource } from "../resources/fuel-types"
import type { GroupsResource } from "../resources/groups"
import type { InspectionFormsResource } from "../resources/inspection-forms"
import type { InspectionSchedulesResource } from "../resources/inspection-schedules"
import type { InventoryAdjustmentReasonsResource } from "../resources/inventory-adjustment-reasons"
import type { InventoryJournalEntriesResource } from "../resources/inventory-journal-entries"
import type { IssuePrioritiesResource } from "../resources/issue-priorities"
import type { IssuesResource } from "../resources/issues"
import type { LabelsResource } from "../resources/labels"
import type { MeterEntriesResource } from "../resources/meter-entries"
import type { PartLocationDetailsResource } from "../resources/part-location-details"
import type { PartLocationsResource } from "../resources/part-locations"
import type { PartsResource } from "../resources/parts"
import type { PurchaseOrderLineItemsResource } from "../resources/purchase-order-line-items"
import type { PurchaseOrdersResource } from "../resources/purchase-orders"
import type { ServiceEntriesResource } from "../resources/service-entries"
import type { ServiceEntryLineItemsResource } from "../resources/service-entry-line-items"
import type { ServiceRemindersResource } from "../resources/service-reminders"
import type { ServiceTasksResource } from "../resources/service-tasks"
import type { SubmittedInspectionFormsResource } from "../resources/submitted-inspection-forms"
import type { VehicleAssignmentsResource } from "../resources/vehicle-assignments"
import type { VehicleStatusesResource } from "../resources/vehicle-statuses"
import type { VehicleTypesResource } from "../resources/vehicle-types"
import type { VehiclesResource } from "../resources/vehicles"
import type { VendorsResource } from "../resources/vendors"
import type { VmrsReasonsForRepairResource } from "../resources/vmrs-reasons-for-repair"
import type { WatchersResource } from "../resources/watchers"
import type { WebhookEventsResource } from "../resources/webhook-events"
import type { WebhooksResource } from "../resources/webhooks"
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
  readonly vehicles: VehiclesResource
  readonly vehicleStatuses: VehicleStatusesResource
  readonly vehicleTypes: VehicleTypesResource
  readonly vehicleAssignments: VehicleAssignmentsResource
  readonly contacts: ContactsResource
  readonly vendors: VendorsResource
  readonly groups: GroupsResource
  readonly equipment: EquipmentResource
  readonly equipmentStatuses: EquipmentStatusesResource
  readonly equipmentTypes: EquipmentTypesResource
  readonly parts: PartsResource
  readonly partLocations: PartLocationsResource
  readonly partLocationDetails: PartLocationDetailsResource
  readonly inventoryJournalEntries: InventoryJournalEntriesResource
  readonly inventoryAdjustmentReasons: InventoryAdjustmentReasonsResource
  readonly purchaseOrders: PurchaseOrdersResource
  /** Line items of a purchase order. */
  readonly purchaseOrderLineItems: PurchaseOrderLineItemsResource
  readonly meterEntries: MeterEntriesResource
  readonly fuelEntries: FuelEntriesResource
  readonly fuelTypes: FuelTypesResource
  readonly expenseEntries: ExpenseEntriesResource
  readonly expenseEntryTypes: ExpenseEntryTypesResource
  readonly faults: FaultsResource
  readonly inspectionForms: InspectionFormsResource
  readonly submittedInspectionForms: SubmittedInspectionFormsResource
  readonly inspectionSchedules: InspectionSchedulesResource
  readonly webhooks: WebhooksResource
  /** Delivery history for webhooks, kept for 30 days. */
  readonly webhookEvents: WebhookEventsResource
}
