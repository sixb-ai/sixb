import { col, defineDataset } from "@sixb/core"

export const northlineServiceCases = defineDataset("northline.service-cases", {
  schema: [
    col("case_id", "string"),
    col("case_number", "string"),
    col("customer_id", "string"),
    col("facility_id", "string"),
    col("equipment_id", "string"),
    col("contract_id", "string"),
    col("alarm_id", "string"),
    col("title", "string"),
    col("source", "string"),
    col("severity", "string"),
    col("status", "string"),
    col("customer_impact", "string"),
    col("coverage_status", "string"),
    col("response_deadline", "timestamp"),
    col("resolution_deadline", "timestamp"),
    col("sla_status", "string"),
    col("owner_name", "string", { nullable: true }),
    col("next_action", "string"),
    col("detected_at", "timestamp"),
    col("acknowledged_at", "timestamp", { nullable: true }),
    col("resolved_at", "timestamp", { nullable: true }),
  ],
})
