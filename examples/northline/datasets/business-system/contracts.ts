import { col, defineDataset } from "@sixb/core"

export const businessContracts = defineDataset("business.contracts", {
  schema: [
    col("contract_id", "string"),
    col("contract_number", "string"),
    col("customer_id", "string"),
    col("facility_id", "string"),
    col("contract_name", "string"),
    col("contract_type", "string"),
    col("status", "string"),
    col("starts_on", "date"),
    col("ends_on", "date"),
    col("coverage_hours", "string"),
    col("response_target_minutes", "int64"),
    col("resolution_target_minutes", "int64"),
    col("included_labor", "boolean"),
    col("major_components_excluded", "boolean"),
    col("approval_threshold", "float64"),
    col("updated_at", "timestamp"),
  ],
})
