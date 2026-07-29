import { defineProjection } from "@sixb/core"
import {
  fieldNotes,
  fieldTechnicians,
  fieldVisits,
  fieldWorkOrders,
} from "../datasets/field-service"
import { Equipment } from "../ontology/equipment"
import { FieldNote } from "../ontology/field-note"
import { ServiceCase } from "../ontology/service-case"
import { ServiceVisit } from "../ontology/service-visit"
import { Technician } from "../ontology/technician"
import { WorkOrder } from "../ontology/work-order"

export const techniciansProjection = defineProjection("field-technicians", Technician)
  .fromDataset(fieldTechnicians)
  .properties({
    id: "technician_id",
    name: "full_name",
    email: "email",
    phone: "phone",
    territory: "territory",
    certification: "certification",
    availability: "availability",
    sourceUpdatedAt: "updated_at",
  })
  .withLinks({})

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

export const visitsProjection = defineProjection("field-visits", ServiceVisit)
  .fromDataset(fieldVisits)
  .properties({
    id: "visit_id",
    number: "visit_number",
    status: "status",
    scheduledStart: "scheduled_start",
    startedAt: "started_at",
    completedAt: "completed_at",
    workPerformed: "work_performed",
    diagnosisDisposition: "diagnosis_disposition",
    completionDisposition: "completion_disposition",
    sourceUpdatedAt: "updated_at",
  })
  .withLinks({
    workOrder: {
      link: ServiceVisit.l.workOrder,
      sourceField: "work_order_id",
      target: WorkOrder,
    },
    technician: {
      link: ServiceVisit.l.technician,
      sourceField: "technician_id",
      target: Technician,
    },
  })

export const fieldNotesProjection = defineProjection("field-notes", FieldNote)
  .fromDataset(fieldNotes)
  .properties({
    id: "note_id",
    noteType: "note_type",
    body: "body",
    recordedAt: "recorded_at",
    sourceUpdatedAt: "updated_at",
  })
  .withLinks({
    visit: { link: FieldNote.l.visit, sourceField: "visit_id", target: ServiceVisit },
    equipment: { link: FieldNote.l.equipment, sourceField: "equipment_id", target: Equipment },
    author: { link: FieldNote.l.author, sourceField: "technician_id", target: Technician },
  })
