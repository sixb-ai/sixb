import { defineObjectType, link, OntologyRegistry, prop } from "@sixb/core"

// Synthetic directory with users, cities, subscriptions and support conversations.
export const City = defineObjectType({
  id: "City",
  name: "City",
  properties: [prop("id", "string", { primary: true, required: true }), prop("name", "string")],
})
export const User = defineObjectType({
  id: "User",
  name: "User",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("firstName", "string", { query: { searchable: true, text: true, sortable: true } }),
    prop("lastName", "string", { query: { searchable: true, text: true, sortable: true } }),
    prop("email", "string", {
      query: { searchable: true, filterable: true, exact: true, text: true },
    }),
    prop("phone", "string", {
      query: { searchable: true, filterable: true, exact: true, text: true },
    }),
    prop("billingCustomerId", "string", {
      query: { searchable: true, filterable: true, exact: true, text: true },
    }),
    prop("status", "string", { query: { searchable: true, filterable: true, facet: true } }),
    prop("verificationStatus", "string", { query: { searchable: true, filterable: true } }),
    prop("createdAt", "timestamp", {
      query: { searchable: true, filterable: true, sortable: true },
    }),
    prop("firstSubscribedAt", "timestamp", {
      query: { searchable: true, filterable: true, sortable: true },
    }),
    prop("searchText", "string", { query: { searchable: true, text: true } }),
    prop("birthDate", "date"),
    prop("newsletterSubscribed", "boolean"),
  ],
  links: [link("currentCity", City, { cardinality: "one" })],
  query: {
    indexes: [
      { kind: "sort", fields: [{ propertyId: "createdAt", direction: "desc" }] },
      {
        kind: "sort",
        fields: [{ propertyId: "createdAt", direction: "desc" }],
        filters: ["status"],
      },
      { kind: "sort", fields: [{ propertyId: "lastName" }, { propertyId: "firstName" }] },
      {
        kind: "sort",
        fields: [{ propertyId: "lastName" }, { propertyId: "firstName" }],
        filters: ["status"],
      },
      { kind: "text", propertyId: "searchText", filters: ["status"] },
    ],
  },
})
export const SupportConversation = defineObjectType({
  id: "SupportConversation",
  name: "Support conversation",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("lastActivityAt", "timestamp", { query: { searchable: true, sortable: true } }),
  ],
  query: {
    indexes: [{ kind: "sort", fields: [{ propertyId: "lastActivityAt", direction: "desc" }] }],
  },
})
export const SupportAccount = defineObjectType({
  id: "SupportAccount",
  name: "Support account",
  properties: [prop("id", "string", { primary: true, required: true })],
  links: [
    link("user", User, { cardinality: "one" }),
    link("conversation", SupportConversation, { cardinality: "many" }),
  ],
})
export const Subscription = defineObjectType({
  id: "Subscription",
  name: "Subscription",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("sourceCreatedAt", "timestamp", { query: { searchable: true, sortable: true } }),
  ],
  query: {
    indexes: [{ kind: "sort", fields: [{ propertyId: "sourceCreatedAt", direction: "desc" }] }],
  },
  links: [link("user", User, { cardinality: "one" })],
})
export const benchmarkOntology = new OntologyRegistry({
  sources: [User, City, SupportAccount, SupportConversation, Subscription],
})
