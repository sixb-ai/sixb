import { defineProjection } from "@sixb/core"
import { businessFacilities } from "../../datasets/business-system/facilities"
import { CustomerAccount } from "../../ontology/customers/customer-account"
import { Facility } from "../../ontology/customers/facility"

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
