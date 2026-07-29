import { defineProjection } from "@sixb/core"
import {
  businessContracts,
  businessCustomers,
  businessFacilities,
  businessQuotes,
} from "../datasets/business-system"
import { CustomerAccount } from "../ontology/customer-account"
import { Facility } from "../ontology/facility"
import { Quote } from "../ontology/quote"
import { ServiceCase } from "../ontology/service-case"
import { ServiceContract } from "../ontology/service-contract"

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

export const facilitiesProjection = defineProjection("business-facilities", Facility)
  .fromDataset(businessFacilities)
  .properties({
    id: "facility_id",
    name: "facility_name",
    addressLine: "address_line",
    city: "city",
    state: "state",
    postalCode: "postal_code",
    territory: "territory",
    timezone: "timezone",
    accessNotes: "access_notes",
    criticality: "criticality",
    status: "status",
    sourceUpdatedAt: "updated_at",
  })
  .withLinks({
    customer: { link: Facility.l.customer, sourceField: "customer_id", target: CustomerAccount },
  })

export const serviceContractsProjection = defineProjection(
  "business-service-contracts",
  ServiceContract
)
  .fromDataset(businessContracts)
  .properties({
    id: "contract_id",
    number: "contract_number",
    name: "contract_name",
    contractType: "contract_type",
    status: "status",
    startsOn: "starts_on",
    endsOn: "ends_on",
    coverageHours: "coverage_hours",
    responseTargetMinutes: "response_target_minutes",
    resolutionTargetMinutes: "resolution_target_minutes",
    includedLabor: "included_labor",
    majorComponentsExcluded: "major_components_excluded",
    approvalThreshold: "approval_threshold",
    sourceUpdatedAt: "updated_at",
  })
  .withLinks({
    customer: {
      link: ServiceContract.l.customer,
      sourceField: "customer_id",
      target: CustomerAccount,
    },
    coveredFacilities: {
      link: ServiceContract.l.coveredFacilities,
      sourceField: "facility_id",
      target: Facility,
    },
  })

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
