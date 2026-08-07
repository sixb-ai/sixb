import { col, defineDataset } from "@sixb/core"

export const businessCustomers = defineDataset("business.customers", {
  schema: [
    col("customer_id", "string"),
    col("account_name", "string"),
    col("service_tier", "string"),
    col("status", "string"),
    col("primary_contact_name", "string"),
    col("primary_contact_email", "string"),
    col("updated_at", "timestamp"),
  ],
})

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

export const businessQuotes = defineDataset("business.quotes", {
  schema: [
    col("quote_id", "string"),
    col("quote_number", "string"),
    col("customer_id", "string"),
    col("facility_id", "string"),
    col("service_case_id", "string", { nullable: true }),
    col("originating_visit_id", "string", { nullable: true }),
    col("scope", "string"),
    col("reason", "string"),
    col("amount", "float64"),
    col("currency", "string"),
    col("status", "string"),
    col("valid_until", "date"),
    col("decision_at", "timestamp", { nullable: true }),
    col("updated_at", "timestamp"),
  ],
  primaryKey: "quote_id",
})
