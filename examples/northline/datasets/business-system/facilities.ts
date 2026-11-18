import { col, defineDataset } from "@sixb/core"

export const businessFacilities = defineDataset("business.facilities", {
  schema: [
    col("facility_id", "string"),
    col("customer_id", "string"),
    col("facility_name", "string"),
    col("address_line", "string"),
    col("city", "string"),
    col("state", "string"),
    col("postal_code", "string"),
    col("territory", "string"),
    col("timezone", "string"),
    col("access_notes", "string"),
    col("criticality", "string"),
    col("status", "string"),
    col("updated_at", "timestamp"),
  ],
})
