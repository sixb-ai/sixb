import {
  defineObjectType,
  defineValueType,
  integerEnum,
  link,
  prop,
  stringEnum,
  valueTypeRef,
} from "@sixb/core/ontology"
import { Customer } from "./customer"
import { Employee } from "./employee"

/**
 * Reusable money value type: an amount paired with its currency.
 *
 * Referenced from properties via `valueTypeRef` so the same shape can be
 * shared across the ontology and evolved in one place.
 */
export const Money = defineValueType({
  id: "money",
  name: "Money",
  description: "A monetary amount and its currency.",
  schema: {
    type: "object",
    properties: {
      amount: { schema: "double", required: true },
      currency: { schema: stringEnum(["EUR", "USD", "GBP"]), required: true },
    },
  },
})

export const Project = defineObjectType({
  id: "Project",
  name: "Project",
  description: "A client project managed by the company.",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", {
      required: true,
      query: { searchable: true, text: true, exact: true, sortable: true, weight: 5 },
    }),
    prop("description", "string", {
      query: { searchable: true, text: true },
    }),
    // String enum — a finite set of string states.
    prop("status", stringEnum(["draft", "active", "paused", "completed", "cancelled"]), {
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    // Integer enum — a finite set of numeric levels.
    prop("priority", integerEnum([1, 2, 3, 4, 5]), {
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop("startDate", "date", {
      query: { searchable: true, filterable: true, sortable: true },
    }),
    prop("deadline", "date", {
      query: { searchable: true, filterable: true, sortable: true },
    }),
    prop("budget", "double", {
      query: { searchable: true, filterable: true, sortable: true },
    }),
    prop("progress", "integer", { mode: "telemetry" }),
    // Array of primitives — free-form labels.
    prop("tags", { type: "array", items: "string" }),
    // Map — dynamic per-phase budgets keyed by phase name.
    prop("phaseBudgets", { type: "map", keySchema: "string", valueSchema: "double" }),
    // Nested object — structured contact details with a nested enum.
    prop("primaryContact", {
      type: "object",
      properties: {
        name: { schema: "string", required: true },
        email: { schema: "string", required: true },
        phone: { schema: "string" },
        preferredChannel: { schema: stringEnum(["email", "phone", "chat"]) },
      },
    }),
    // Array of objects — milestones, each a structured record with its own enum.
    prop("milestones", {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { schema: "string", required: true },
          dueDate: { schema: "date", required: true },
          status: {
            schema: stringEnum(["pending", "in_progress", "done", "blocked"]),
            required: true,
          },
        },
      },
    }),
    // Value-type reference — resolves to the shared Money object shape.
    prop("contractValue", valueTypeRef(Money)),
  ],
  search: {
    title: "name",
    defaultText: ["name", "description"],
    exact: ["id", "name"],
  },
  links: [
    link("customer", Customer, { cardinality: "one" }),
    link("lead", Employee, { cardinality: "one" }),
    link("members", Employee, { cardinality: "many" }),
  ],
})
