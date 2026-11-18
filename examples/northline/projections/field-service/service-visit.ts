import { defineProjection } from "@sixb/core"
import { fieldVisits } from "../../datasets/field-service/visits"
import { ServiceVisit } from "../../ontology/field-service/service-visit"
import { Technician } from "../../ontology/field-service/technician"
import { WorkOrder } from "../../ontology/field-service/work-order"

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
