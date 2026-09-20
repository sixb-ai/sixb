import { defineObjectType, link, prop } from "@sixb/core/ontology"

export const Client = defineObjectType({
  id: "Client",
  name: "Client",
  properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
})

export const Account = defineObjectType({
  id: "Account",
  name: "Account",
  properties: [prop("id", "string", { required: true, primary: true })],
  links: [link("client", Client, { cardinality: "one" })],
})

export const Campaign = defineObjectType({
  id: "Campaign",
  name: "Campaign",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", {
      required: true,
      query: { searchable: true, text: true, sortable: true },
    }),
    prop("status", "string"),
    prop("reviewed", "boolean"),
    prop("clicks", "integer", { mode: "telemetry" }),
  ],
  links: [link("account", Account, { cardinality: "one" })],
  search: { title: "name", defaultText: ["name"] },
})
