import { col, defineDataset } from "@sixb/core"

export const fieldTechnicians = defineDataset("field-service.technicians", {
  schema: [
    col("technician_id", "string"),
    col("full_name", "string"),
    col("email", "string"),
    col("phone", "string"),
    col("territory", "string"),
    col("certification", "string"),
    col("availability", "string"),
    col("updated_at", "timestamp"),
  ],
})

export const fieldWorkOrders = defineDataset("field-service.work-orders", {
  schema: [
    col("work_order_id", "string"),
    col("work_order_number", "string"),
    col("service_case_id", "string", { nullable: true }),
    col("equipment_id", "string"),
    col("technician_id", "string", { nullable: true }),
    col("title", "string"),
    col("priority", "string"),
    col("status", "string"),
    col("scope", "string"),
    col("scheduled_start", "timestamp", { nullable: true }),
    col("scheduled_end", "timestamp", { nullable: true }),
    col("dispatched_at", "timestamp", { nullable: true }),
    col("completed_at", "timestamp", { nullable: true }),
    col("updated_at", "timestamp"),
  ],
})

export const fieldVisits = defineDataset("field-service.visits", {
  schema: [
    col("visit_id", "string"),
    col("visit_number", "string"),
    col("work_order_id", "string"),
    col("technician_id", "string"),
    col("status", "string"),
    col("scheduled_start", "timestamp"),
    col("started_at", "timestamp", { nullable: true }),
    col("completed_at", "timestamp", { nullable: true }),
    col("work_performed", "string", { nullable: true }),
    col("diagnosis_disposition", "string", { nullable: true }),
    col("completion_disposition", "string", { nullable: true }),
    col("updated_at", "timestamp"),
  ],
})

export const fieldNotes = defineDataset("field-service.notes", {
  schema: [
    col("note_id", "string"),
    col("visit_id", "string"),
    col("equipment_id", "string"),
    col("technician_id", "string"),
    col("note_type", "string"),
    col("body", "string"),
    col("recorded_at", "timestamp"),
    col("updated_at", "timestamp"),
  ],
})
