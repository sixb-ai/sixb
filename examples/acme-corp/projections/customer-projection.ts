import { defineProjection, fromForeignKey } from "@sixb/core"
import { erpCustomersDataset } from "../datasets/erp"
import { Customer } from "../ontology/customer"
import { Employee } from "../ontology/employee"

export const customerProjection = defineProjection("customer-proj", Customer)
  .fromDataset(erpCustomersDataset)
  .properties({
    id: "customer_id",
    name: "contact_name",
    email: "contact_email",
    company: "company_name",
    industry: "industry_sector",
    tier: "service_tier",
    accountManagerRef: "account_mgr_id",
  })
  .withLinks({
    accountManager: fromForeignKey({
      link: Customer.l.accountManager,
      sourceProperty: Customer.p.accountManagerRef,
      target: Employee,
    }),
  })
