import { defineObjectType, link, prop, stringEnum } from "@sixb/core/ontology"
import { BuildingAlarm } from "./building-alarm"
import { CustomerAccount } from "./customer-account"
import { Equipment } from "./equipment"
import { Facility } from "./facility"
import { ServiceContract } from "./service-contract"

export const serviceCaseStatuses = [
  "new",
  "triage",
  "dispatching",
  "in_service",
  "awaiting_authorization",
  "resolved",
  "closed",
  "cancelled",
] as const

export const ServiceCase = defineObjectType({
  id: "ServiceCase",
  name: "Service case",
  description: "Northline's cross-system coordination record for a customer-impacting issue.",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("number", "string", {
      required: true,
      query: { searchable: true, text: true, exact: true, sortable: true, weight: 5 },
    }),
    prop("title", "string", {
      required: true,
      query: { searchable: true, text: true, sortable: true, weight: 5 },
    }),
    prop("source", stringEnum(["alarm", "customer_call", "technician", "inspection"]), {
      required: true,
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop("severity", stringEnum(["low", "medium", "high", "critical"]), {
      required: true,
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop("status", stringEnum([...serviceCaseStatuses]), {
      required: true,
      query: { searchable: true, filterable: true, exact: true, facet: true, sortable: true },
    }),
    prop("customerImpact", "string", {
      required: true,
      query: { searchable: true, text: true },
    }),
    prop("coverageStatus", stringEnum(["covered", "partially_covered", "not_covered", "unknown"]), {
      required: true,
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop("responseDeadline", "timestamp", {
      required: true,
      query: { searchable: true, sortable: true },
    }),
    prop("resolutionDeadline", "timestamp", {
      required: true,
      query: { searchable: true, sortable: true },
    }),
    prop("slaStatus", stringEnum(["on_track", "at_risk", "breached", "met"]), {
      required: true,
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop("ownerName", "string", { query: { searchable: true, exact: true } }),
    prop("nextAction", "string"),
    prop("currentVisitId", "string"),
    prop("resolutionSummary", "string"),
    prop("detectedAt", "timestamp", {
      required: true,
      query: { searchable: true, sortable: true },
    }),
    prop("acknowledgedAt", "timestamp"),
    prop("resolvedAt", "timestamp"),
    prop("closedAt", "timestamp"),
  ],
  links: [
    link("customer", CustomerAccount, { cardinality: "one" }),
    link("facility", Facility, { cardinality: "one" }),
    link("equipment", Equipment, { cardinality: "one" }),
    link("appliedContract", ServiceContract, { cardinality: "one" }),
    link("originatingAlarms", BuildingAlarm, { cardinality: "many" }),
  ],
  search: {
    title: "number",
    defaultText: ["number", "title", "customerImpact"],
    exact: ["id", "number"],
  },
})
