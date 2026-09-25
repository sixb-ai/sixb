/**
 * An ontology shaped like a real app's: wide object types, enums, arrays, link properties, a
 * self-link and many direct links. Relations that stay within TypeScript's limits on a toy
 * ontology overflowed on this one.
 */
import { defineObjectType, link, prop, stringEnum } from "@sixb/core/ontology"

export const Company = defineObjectType({
  id: "Company",
  name: "Company",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true, query: { searchable: true, text: true } }),
    prop("legalName", "string", { nullable: true, query: { searchable: true, text: true } }),
    prop("website", "string", { nullable: true }),
    prop("description", "string", { nullable: true, query: { searchable: true, text: true } }),
  ],
})

export const EmailAddress = defineObjectType({
  id: "EmailAddress",
  name: "EmailAddress",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("address", "string", { required: true }),
    prop("normalizedAddress", "string", {
      required: true,
      query: { searchable: true, filterable: true, exact: true },
    }),
  ],
})

export const Contact = defineObjectType({
  id: "Contact",
  name: "Contact",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("firstName", "string", { nullable: true, query: { searchable: true, text: true } }),
    prop("lastName", "string", { required: true, query: { searchable: true, text: true } }),
    prop("salutation", stringEnum(["M.", "Mme", "Mx", "Dr"]), { nullable: true }),
    prop("jobTitle", "string", { nullable: true }),
    prop("type", stringEnum(["owner", "lawyer", "accountant", "banker", "advisor", "other"]), {
      nullable: true,
      query: { searchable: true, filterable: true, exact: true },
    }),
    prop("phoneNumbers", { type: "array", items: "string" }, { nullable: true }),
    prop("kind", stringEnum(["internal", "external"]), {
      required: true,
      query: { searchable: true, filterable: true, exact: true },
    }),
  ],
  links: [
    link("company", Company, { cardinality: "one" }),
    link("emailAddresses", EmailAddress, {
      cardinality: "many",
      properties: [prop("isPrimary", "boolean", { nullable: true })],
    }),
  ],
})

export const Folder = defineObjectType({
  id: "Folder",
  name: "Folder",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true, query: { searchable: true, text: true } }),
    prop("driveId", "string", { required: true }),
    prop("itemId", "string", { required: true }),
    prop("webUrl", "string", { required: true }),
    prop("modifiedAt", "timestamp", { nullable: true }),
  ],
  links: [link.self("parent", { cardinality: "one" })],
})

export const Project = defineObjectType({
  id: "Project",
  name: "Project",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true, query: { searchable: true, text: true } }),
    prop("type", stringEnum(["acquisition", "disposal"]), { required: true }),
    prop("status", stringEnum(["active", "paused", "completed", "cancelled"]), {
      required: true,
      query: { searchable: true, filterable: true, exact: true },
    }),
    prop("summary", "string", { nullable: true, query: { searchable: true, text: true } }),
    prop("startedAt", "date", { nullable: true }),
    prop("lastActivityAt", "timestamp", {
      nullable: true,
      query: { searchable: true, filterable: true, sortable: true },
    }),
  ],
  links: [
    link("contacts", Contact, {
      cardinality: "many",
      properties: [prop("side", stringEnum(["client", "counterparty"]), { required: true })],
    }),
    link("rootFolder", Folder, { cardinality: "one" }),
    link("targetCompany", Company, { cardinality: "one" }),
    link("clientCompany", Company, { cardinality: "one" }),
  ],
})

export const EmailThread = defineObjectType({
  id: "EmailThread",
  name: "EmailThread",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("subject", "string", { nullable: true, query: { searchable: true, text: true } }),
    prop("lastMessageAt", "timestamp", {
      nullable: true,
      query: { searchable: true, filterable: true, sortable: true },
    }),
    prop("messageCount", "integer", { nullable: true }),
  ],
})

export const EmailMessage = defineObjectType({
  id: "EmailMessage",
  name: "EmailMessage",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("subject", "string", { nullable: true, query: { searchable: true, text: true } }),
    prop("bodyText", "string", { nullable: true, query: { searchable: true, text: true } }),
    prop("sentAt", "timestamp", {
      nullable: true,
      query: { searchable: true, filterable: true, sortable: true },
    }),
    prop("referenceIds", { type: "array", items: "string" }, { nullable: true }),
    prop("sendStatus", stringEnum(["received", "draft", "sent", "failed"]), { required: true }),
    prop("assignmentConfidence", "double", { nullable: true }),
    prop("assignmentStatus", stringEnum(["unassigned", "assigned", "needs_review"]), {
      required: true,
      query: { searchable: true, filterable: true, exact: true },
    }),
  ],
  links: [
    link("thread", EmailThread, { cardinality: "one" }),
    link.self("replyTo", { cardinality: "one" }),
    link("from", EmailAddress, { cardinality: "one" }),
    link("to", EmailAddress, { cardinality: "many" }),
    link("cc", EmailAddress, { cardinality: "many" }),
    link("contacts", Contact, { cardinality: "many" }),
    link("projects", Project, { cardinality: "many" }),
  ],
})
