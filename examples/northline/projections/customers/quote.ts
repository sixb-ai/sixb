import { defineProjection } from "@sixb/core"
import { businessQuotes } from "../../datasets/business-system/quotes"
import { CustomerAccount } from "../../ontology/customers/customer-account"
import { Facility } from "../../ontology/customers/facility"
import { Quote } from "../../ontology/customers/quote"
import { ServiceCase } from "../../ontology/service-case"

export const quotesProjection = defineProjection("business-quotes", Quote)
  .fromDataset(businessQuotes)
  .properties({
    id: "quote_id",
    number: "quote_number",
    scope: "scope",
    reason: "reason",
    amount: "amount",
    currency: "currency",
    status: "status",
    validUntil: "valid_until",
    decisionAt: "decision_at",
    sourceUpdatedAt: "updated_at",
  })
  .withLinks({
    customer: { link: Quote.l.customer, sourceField: "customer_id", target: CustomerAccount },
    facility: { link: Quote.l.facility, sourceField: "facility_id", target: Facility },
    serviceCase: {
      link: Quote.l.serviceCase,
      sourceField: "service_case_id",
      target: ServiceCase,
    },
  })
