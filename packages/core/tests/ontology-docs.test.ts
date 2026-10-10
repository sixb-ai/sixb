import { expect, test } from "bun:test"
import {
  can,
  defineAction,
  defineGroup,
  defineMarking,
  defineObjectType,
  defineRole,
  type EmbeddingModel,
  link,
  prop,
  ref,
  resolveAuthorizationContext,
  SixbHost,
  stringEnum,
} from "../src"
import { resolveAgentPropertyClearance } from "../src/agents/authority"
import { renderOntologyDocs } from "../src/ontology/docs-markdown"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const embedding: EmbeddingModel = {
  providerId: "test",
  modelId: "embedding-v1",
  definition: { kind: "embedding", providerId: "test", modelId: "embedding-v1", dimensions: 3 },
  async embed({ texts }) {
    return { vectors: texts.map(() => [1, 0, 0]) }
  },
}

const financial = defineMarking("financial")

const Customer = defineObjectType({
  id: "Customer",
  name: "Customer",
  description: "A company we bill, e.g. a retailer. Synced nightly from the CRM.",
  properties: [
    prop("id", "string", { required: true, primary: true, description: "CRM identifier." }),
    prop("name", "string", {
      required: true,
      query: { searchable: true, filterable: true, sortable: true, text: true },
    }),
    prop("segment", stringEnum(["smb", "enterprise"]), {
      query: { searchable: true, filterable: true, facet: true },
    }),
  ],
})

const Invoice = defineObjectType({
  id: "Invoice",
  name: "Customer invoice",
  description: "A bill sent to a customer.",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("status", stringEnum(["draft", "sent", "paid"]), {
      required: true,
      description: "Lifecycle | state.",
      query: { searchable: true, filterable: true, sortable: true, facet: true },
    }),
    prop(
      "tags",
      { type: "array", items: "string" },
      { query: { searchable: true, filterable: true } }
    ),
    prop("summary", "string"),
    prop("internalNotes", "string", { markings: [financial] }),
  ],
  links: [link("customer", Customer, { cardinality: "one", description: "The billed customer." })],
  search: {
    vectors: {
      content: { source: ["summary"], model: embedding },
      internal: { source: ["internalNotes"], model: embedding },
    },
  },
})

const Payment = defineObjectType({
  id: "Payment",
  name: "Payment",
  properties: [prop("id", "string", { required: true, primary: true })],
  links: [
    link("invoice", Invoice, { cardinality: "one" }),
    link.any("attachedTo", { description: "Any record the payment documents." }),
  ],
})

const AuditEntry = defineObjectType({
  id: "AuditEntry",
  name: "Audit entry",
  description: "Restricted to auditors.",
  properties: [prop("id", "string", { required: true, primary: true })],
  links: [link("invoice", Invoice)],
})

const sendInvoice = defineAction("send-invoice", {
  description: "Email the invoice to its customer.",
})
  .on(Invoice)
  .params({
    message: { schema: "string", required: true, description: "Body of the email." },
    copyTo: { schema: ref(Customer) },
  })
  .writeback(async () => {})

const sales = defineGroup("sales")
const salesReader = defineRole("sales-reader", {
  grantedTo: [sales],
  grants: [can.view([Customer, Invoice, Payment]), can.apply(sendInvoice)],
})

// The reader sees Customer, Invoice and Payment, without the financial marking. Its docs must not
// mention AuditEntry (its doc, its team notes, its link into Invoice), nor Invoice's marked
// property and the vector profile built from it. Payment's wildcard link keeps its declared `*`
// target, which the reader's view expands into every visible type, and adds no incoming links. Reproduce: render `objectType` instead of
// `withoutHiddenProperties(...)` in ontology/docs-markdown.ts and the marked property reappears.
test("renders the reader's view of each type, merged with the team's docs", () => {
  const host = new SixbHost({
    ontology: [Customer, Invoice, Payment, AuditEntry],
    actions: [sendInvoice],
    models: { embedding: [embedding] },
    markings: [financial],
    groups: [sales],
    roles: [salesReader],
    ontologyDocs: {
      modules: [
        { path: "crm.ts", objectTypeIds: ["Customer", "Payment"] },
        { path: "billing/invoice.ts", objectTypeIds: ["Invoice"] },
        { path: "audit.ts", objectTypeIds: ["AuditEntry"] },
        { path: "index.ts", objectTypeIds: ["Customer", "Payment", "Invoice", "AuditEntry"] },
      ],
      docs: [
        { path: "billing/invoice.md", contents: "Invoices are numbered per year.\n" },
        { path: "audit.md", contents: "# Audit\n\nOnly auditors read this.\n" },
        { path: "conventions.md", contents: "Intro\n\n## Naming conventions\n" },
      ],
      scripts: [
        { path: "billing/scripts/export.py", contents: "print('export')\n", mode: 0o755 },
        { path: "billing/scripts/lib/util.py", contents: "" },
      ],
    },
    ...createTestRuntimeDeps(),
  })
  const context = resolveAuthorizationContext({
    principal: { type: "user", id: "user-sales" },
    groupIds: ["sales"],
    roles: host.definitions.security.listResolvedRoles(),
  })
  const sixb = createTestSixb(host, { authorization: context })
  const clearance = resolveAgentPropertyClearance(host.definitions.ontology, {
    type: "principal",
    context,
  })

  const rendered = renderOntologyDocs({
    catalog: host.definitions.ontologyDocs,
    objectTypes: sixb.objects.listTypes(),
    valueTypesById: sixb.objects.getValueTypesById(),
    actionsFor: (objectType) => sixb.actions.listForType(objectType),
    ...(clearance === undefined ? {} : { hiddenPropertyIds: clearance.hiddenPropertyIds }),
  })

  const file = (path: string) =>
    rendered.files.find((candidate) => candidate.path === path)?.contents
  expect(rendered.files.map(({ path, mode }) => ({ path, mode }))).toEqual([
    { path: "billing/invoice.md", mode: undefined },
    { path: "billing/scripts/export.py", mode: 0o755 },
    { path: "billing/scripts/lib/util.py", mode: undefined },
    { path: "conventions.md", mode: undefined },
    { path: "crm/Customer.md", mode: undefined },
    { path: "crm/Payment.md", mode: undefined },
  ])
  expect(file("billing/invoice.md")).toBe(
    [
      "# Invoice — Customer invoice",
      "",
      "A bill sent to a customer.",
      "",
      "## Properties",
      "",
      "| Property | Type | Query | Description |",
      "| --- | --- | --- | --- |",
      "| `id` | string (primary key) | filter: eq, in |  |",
      "| `status` | one of `draft`, `sent`, `paid` (required) | filter: eq, neq, lt, lte, gt, gte, in, exists; sort; facet | Lifecycle \\| state. |",
      "| `tags` | array of string | filter: contains |  |",
      "| `summary` | string | — |  |",
      "",
      "## Vector search profiles",
      "",
      "| Profile | Sources |",
      "| --- | --- |",
      "| `content` | `summary` |",
      "",
      "## Links",
      "",
      "| Link | Target | Cardinality | Description | Target description |",
      "| --- | --- | --- | --- | --- |",
      "| `customer` | `Customer` | one | The billed customer. | A company we bill, e.g. a retailer. |",
      "",
      "## Incoming links",
      "",
      "Declared on other types; traverse them with direction `incoming`.",
      "",
      "| From | Link | Cardinality | Description |",
      "| --- | --- | --- | --- |",
      "| `Payment` | `invoice` | one |  |",
      "",
      "## Actions",
      "",
      "### `send-invoice`",
      "",
      "Email the invoice to its customer.",
      "",
      "| Param | Type | Required | Description |",
      "| --- | --- | --- | --- |",
      "| `message` | string | yes | Body of the email. |",
      "| `copyTo` | reference to `Customer` | no |  |",
      "",
      "## Project notes",
      "",
      "Invoices are numbered per year.",
      "",
    ].join("\n")
  )
  expect(file("crm/Customer.md")).toBe(
    [
      "# Customer",
      "",
      "A company we bill, e.g. a retailer. Synced nightly from the CRM.",
      "",
      "## Properties",
      "",
      "| Property | Type | Query | Description |",
      "| --- | --- | --- | --- |",
      "| `id` | string (primary key) | filter: eq, in | CRM identifier. |",
      "| `name` | string (required) | filter: eq, neq, lt, lte, gt, gte, in, contains, exists; sort; text |  |",
      "| `segment` | one of `smb`, `enterprise` | filter: eq, neq, lt, lte, gt, gte, in, exists; facet |  |",
      "",
      "## Incoming links",
      "",
      "Declared on other types; traverse them with direction `incoming`.",
      "",
      "| From | Link | Cardinality | Description |",
      "| --- | --- | --- | --- |",
      "| `Invoice` | `customer` | one | The billed customer. |",
      "",
    ].join("\n")
  )
  expect(file("crm/Payment.md")).toBe(
    [
      "# Payment",
      "",
      "## Properties",
      "",
      "| Property | Type | Query | Description |",
      "| --- | --- | --- | --- |",
      "| `id` | string (primary key) | filter: eq, in |  |",
      "",
      "## Links",
      "",
      "| Link | Target | Cardinality | Description | Target description |",
      "| --- | --- | --- | --- | --- |",
      "| `invoice` | `Invoice` | one |  | A bill sent to a customer. |",
      "| `attachedTo` | `*` | many | Any record the payment documents. |  |",
      "",
    ].join("\n")
  )
  expect(file("conventions.md")).toBe("Intro\n\n## Naming conventions\n")
  expect(rendered.index).toEqual([
    { path: "billing/invoice.md", summary: "Invoice: A bill sent to a customer." },
    { path: "billing/scripts/", summary: "Scripts" },
    { path: "conventions.md", summary: "Naming conventions" },
    { path: "crm/Customer.md", summary: "Customer: A company we bill, e.g. a retailer." },
    { path: "crm/Payment.md", summary: "Payment" },
  ])
})
