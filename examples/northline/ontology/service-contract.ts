import { defineObjectType, link, prop, stringEnum } from "@sixb/core/ontology"
import { CustomerAccount } from "./customer-account"
import { Facility } from "./facility"

export const ServiceContract = defineObjectType({
  id: "ServiceContract",
  name: "Service contract",
  description: "Northline's active service coverage and response commitment.",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("number", "string", {
      required: true,
      query: { searchable: true, text: true, exact: true, sortable: true, weight: 5 },
    }),
    prop("name", "string", { required: true, query: { searchable: true, text: true } }),
    prop("contractType", stringEnum(["preventive", "priority_care", "full_service"]), {
      required: true,
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop("status", stringEnum(["draft", "active", "expiring", "expired"]), {
      required: true,
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop("startsOn", "date", { required: true, query: { searchable: true, sortable: true } }),
    prop("endsOn", "date", { required: true, query: { searchable: true, sortable: true } }),
    prop("coverageHours", stringEnum(["business_hours", "24_7"]), { required: true }),
    prop("responseTargetMinutes", "integer", {
      required: true,
      query: { searchable: true, sortable: true },
    }),
    prop("resolutionTargetMinutes", "integer", { required: true }),
    prop("includedLabor", "boolean", { required: true }),
    prop("majorComponentsExcluded", "boolean", { required: true }),
    prop("approvalThreshold", "double", { required: true }),
    prop("sourceUpdatedAt", "timestamp", { query: { searchable: true, sortable: true } }),
  ],
  links: [
    link("customer", CustomerAccount, { cardinality: "one" }),
    link("coveredFacilities", Facility, { cardinality: "many" }),
  ],
  search: { title: "number", defaultText: ["number", "name"], exact: ["id", "number"] },
})
