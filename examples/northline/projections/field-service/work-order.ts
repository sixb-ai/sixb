import { defineProjection } from "@sixb/core"
import { fieldWorkOrders } from "../../datasets/field-service/work-orders"
import { Equipment } from "../../ontology/equipment/equipment"
import { Technician } from "../../ontology/field-service/technician"
import { WorkOrder } from "../../ontology/field-service/work-order"
import { ServiceCase } from "../../ontology/service-case"

export const workOrdersProjection = defineProjection("field-work-orders", WorkOrder)
  .fromDataset(fieldWorkOrders)
  .properties({
    id: "work_order_id",
    number: "work_order_number",
    title: "title",
    priority: "priority",
    status: "status",
    scope: "scope",
    scheduledStart: "scheduled_start",
    scheduledEnd: "scheduled_end",
    dispatchedAt: "dispatched_at",
    completedAt: "completed_at",
    sourceUpdatedAt: "updated_at",
  })
  .withLinks({
    serviceCase: {
      link: WorkOrder.l.serviceCase,
      sourceField: "service_case_id",
      target: ServiceCase,
    },
    equipment: { link: WorkOrder.l.equipment, sourceField: "equipment_id", target: Equipment },
    assignee: { link: WorkOrder.l.assignee, sourceField: "technician_id", target: Technician },
  })
