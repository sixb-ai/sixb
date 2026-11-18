import { defineProjection } from "@sixb/core"
import { businessCustomers } from "../../datasets/business-system/customers"
import { CustomerAccount } from "../../ontology/customers/customer-account"

export const customerAccountsProjection = defineProjection(
  "business-customer-accounts",
  CustomerAccount
)
  .fromDataset(businessCustomers)
  .properties({
    id: "customer_id",
    name: "account_name",
    serviceTier: "service_tier",
    status: "status",
    primaryContactName: "primary_contact_name",
    primaryContactEmail: "primary_contact_email",
    sourceUpdatedAt: "updated_at",
  })
  .withLinks({})
