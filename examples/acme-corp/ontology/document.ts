import { defineObjectType, link, prop, stringEnum } from "@sixb/core/ontology"
import { Employee } from "./employee"
import { Project } from "./project"

export const Document = defineObjectType({
  id: "Document",
  name: "Document",
  description: "A project document or deliverable.",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("title", "string", { required: true }),
    prop("type", stringEnum(["proposal", "contract", "specification", "report", "deliverable"])),
    prop("version", "string"),
    prop("createdAt", "timestamp"),
    prop("attachment", "fileRef"),
  ],
  links: [
    link("project", Project, { cardinality: "one" }),
    link("author", Employee, { cardinality: "one" }),
  ],
})

/**
 * A signed contract — extends Document to demonstrate ontology inheritance.
 * Inherits all Document properties and links, adds contract-specific fields.
 */
export const Contract = defineObjectType({
  id: "Contract",
  name: "Contract",
  description: "A signed contract document with binding terms.",
  extends: Document,
  properties: [prop("signedAt", "timestamp"), prop("expiresAt", "date"), prop("value", "double")],
})
