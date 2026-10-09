import { describe, expect, test } from "bun:test"
import {
  type AuthorizationContext,
  AuthorizationError,
  can,
  defineGroup,
  defineMarking,
  defineObjectType,
  defineRole,
  link,
  type ObjectQuery,
  prop,
  resolveAuthorizationContext,
  SixbHost,
} from "../src"
import { createAuthorizedObjectReader } from "../src/execution/authorized-object-reader"
import { createDelegatedRequestScope, createTestingScope } from "../src/execution/scopes"
import type { OntologyRegistry } from "../src/ontology"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const projectId = "markings"

const financial = defineMarking("financial", { label: "Financial" })
const pii = defineMarking("pii")

const Customer = defineObjectType({
  id: "customer",
  name: "Customer",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string"),
    prop("taxId", "string", { markings: [pii] }),
  ],
})

const Invoice = defineObjectType({
  id: "invoice",
  name: "Invoice",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("title", "string", { query: { searchable: true, text: true } }),
    prop("notes", "string", { query: { searchable: true, text: true }, markings: [financial] }),
    prop("amount", "double", {
      required: true,
      query: { searchable: true, filterable: true, sortable: true, facet: true },
      markings: [financial],
    }),
  ],
  links: [link("customer", Customer, { cardinality: "one" })],
  search: { title: "title", defaultText: ["title", "notes"] },
})

const DisputedInvoice = defineObjectType({
  id: "disputed-invoice",
  name: "Disputed Invoice",
  extends: Invoice,
  properties: [prop("reason", "string")],
})

const sales = defineGroup("sales")
const finance = defineGroup("finance")

const invoiceReader = defineRole("invoice-reader", {
  grantedTo: [sales, finance],
  grants: [can.view([Invoice, Customer]), can.edit(Invoice)],
})

// A role may carry only clearances: reading still needs a view grant from another role.
const financeClearance = defineRole("finance-clearance", {
  grantedTo: [finance],
  clearances: [financial],
})

function createHost() {
  return new SixbHost({
    id: projectId,
    ontology: [Customer, Invoice, DisputedInvoice],
    markings: [financial, pii],
    groups: [sales, finance],
    roles: [invoiceReader, financeClearance],
    ...createTestRuntimeDeps(),
  })
}

function contextFor(host: SixbHost, groupIds: readonly string[]): AuthorizationContext {
  return resolveAuthorizationContext({
    principal: { type: "user", id: `user-${groupIds.join("-")}` },
    groupIds,
    roles: host.definitions.security.listResolvedRoles(),
  })
}

async function seed(host: SixbHost) {
  const trusted = createTestSixb(host)
  await trusted.objects(Customer).upsert({ properties: { id: "c1", name: "Acme", taxId: "FR-1" } })
  await trusted.objects(Invoice).upsert({
    properties: { id: "inv-1", title: "Alpha", notes: "bonus-word", amount: 120 },
  })
  await trusted
    .objects(DisputedInvoice)
    .upsert({ properties: { id: "inv-2", title: "Beta", amount: 80, reason: "late" } })
  await trusted.objects.upsertLink(Invoice.id, "inv-1", "customer", {
    targetTypeId: Customer.id,
    targetId: "c1",
  })
  return {
    trusted,
    salesReader: createTestSixb(host, { authorization: contextFor(host, ["sales"]) }),
    financeReader: createTestSixb(host, { authorization: contextFor(host, ["finance"]) }),
  }
}

const invoices: ObjectQuery = { kind: "start", objectTypeId: Invoice.id }

describe("markings on object reads", () => {
  test("a reader without clearance receives marked properties omitted and listed", async () => {
    const host = createHost()
    const { salesReader } = await seed(host)

    const invoice = await salesReader.objects.get(Invoice.id, "inv-1")
    expect(invoice?.properties).toEqual({ id: "inv-1", title: "Alpha" })
    // Every hidden property is listed, even one without a value, so redactions reveal nothing.
    expect(invoice?.redactions).toEqual({
      notes: { reason: "missing_clearance" },
      amount: { reason: "missing_clearance" },
    })

    const disputed = await salesReader.objects.get(DisputedInvoice.id, "inv-2")
    expect(disputed?.properties).toEqual({ id: "inv-2", title: "Beta", reason: "late" })

    const listed = await salesReader.objects.list({ objectTypeIds: [Invoice.id] })
    expect(listed.objects.map((row) => row.properties.amount)).toEqual([undefined])
  })

  test("a cleared reader receives the values it is cleared for", async () => {
    const host = createHost()
    const { financeReader } = await seed(host)

    const invoice = await financeReader.objects.get(Invoice.id, "inv-1")
    expect(invoice?.properties).toEqual({
      id: "inv-1",
      title: "Alpha",
      notes: "bonus-word",
      amount: 120,
    })
    expect(invoice?.redactions).toBeUndefined()

    // Clearance is per marking: finance is not cleared for pii.
    const customer = await financeReader.objects.get(Customer.id, "c1")
    expect(customer?.properties).toEqual({ id: "c1", name: "Acme" })
    expect(customer?.redactions).toEqual({ taxId: { reason: "missing_clearance" } })
  })

  test("trusted executions read every property", async () => {
    const host = createHost()
    const { trusted } = await seed(host)

    const invoice = await trusted.objects.get(Invoice.id, "inv-1")
    expect(invoice?.properties.amount).toBe(120)
    expect(invoice?.redactions).toBeUndefined()
  })

  test("query results, subtypes, and expanded objects are redacted", async () => {
    const host = createHost()
    const { salesReader } = await seed(host)

    const result = await salesReader.objects.executeQuery({
      query: {
        kind: "expand",
        input: {
          kind: "limit",
          limit: 10,
          input: { kind: "start", objectTypeId: Invoice.id, includeSubtypes: true },
        },
        expansions: [{ linkId: "customer", direction: "outgoing" }],
      },
    })
    const rows = [...result.objects].sort((a, b) => a.primaryId.localeCompare(b.primaryId))
    expect(rows.map((row) => row.properties.amount)).toEqual([undefined, undefined])
    expect(rows.map((row) => Object.keys(row.redactions ?? {}).sort())).toEqual([
      ["amount", "notes"],
      ["amount", "notes"],
    ])
    expect(rows[0]?.links?.customer).toMatchObject({
      properties: { id: "c1", name: "Acme" },
      redactions: { taxId: { reason: "missing_clearance" } },
    })
  })

  test("projecting a marked property returns it redacted instead of failing", async () => {
    const host = createHost()
    const { salesReader } = await seed(host)

    const result = await salesReader.objects.executeQuery({
      query: { kind: "project", input: invoices, properties: ["title", "amount"] },
    })
    expect(result.objects[0]?.properties).toEqual({ title: "Alpha" })
    expect(result.objects[0]?.redactions).toMatchObject({ amount: { reason: "missing_clearance" } })
  })
})

describe("markings on queries", () => {
  const amountAbove100: ObjectQuery = {
    kind: "filter",
    input: invoices,
    predicate: { op: "gt", propertyId: "amount", value: 100 },
  }

  test("filtering, sorting, faceting, or searching by a marked property is rejected", async () => {
    const host = createHost()
    const { salesReader } = await seed(host)

    const rejected = [
      () => salesReader.objects.executeQuery({ query: amountAbove100 }),
      () => salesReader.objects.count({ query: amountAbove100 }),
      () => salesReader.objects.exists({ query: amountAbove100 }),
      () =>
        salesReader.objects.executeQuery({
          query: {
            kind: "sort",
            input: invoices,
            fields: [{ kind: "property", propertyId: "amount" }],
          },
        }),
      () =>
        salesReader.objects.facet({
          query: invoices,
          facets: [{ propertyId: "amount", limit: 5 }],
        }),
      () =>
        salesReader.objects.executeQuery({
          query: { kind: "text", input: invoices, query: "bonus-word", fields: ["notes"] },
        }),
    ]
    for (const request of rejected) {
      await expect(request()).rejects.toBeInstanceOf(AuthorizationError)
    }
    await expect(salesReader.objects.executeQuery({ query: amountAbove100 })).rejects.toThrow(
      "[Sixb] Cannot filter by 'invoice.amount' at '$.predicate': it requires clearance for marking 'financial'."
    )
  })

  test("a subtype's marked property cannot be queried through its parent", async () => {
    const host = createHost()
    const { salesReader } = await seed(host)

    await expect(
      salesReader.objects.count({
        query: {
          kind: "filter",
          input: { kind: "start", objectTypeId: Invoice.id, includeSubtypes: true },
          predicate: { op: "gt", propertyId: "amount", value: 100 },
        },
      })
    ).rejects.toBeInstanceOf(AuthorizationError)
  })

  test("a cleared reader queries marked properties", async () => {
    const host = createHost()
    const { financeReader } = await seed(host)

    const result = await financeReader.objects.executeQuery({ query: amountAbove100 })
    expect(result.objects.map((row) => row.primaryId)).toEqual(["inv-1"])
  })

  test("default text search skips the fields a reader cannot read", async () => {
    const host = createHost()
    const { salesReader, financeReader } = await seed(host)
    const search = (text: string): ObjectQuery => ({ kind: "text", input: invoices, query: text })

    const hidden = await salesReader.objects.executeQuery({ query: search("bonus-word") })
    expect(hidden.objects).toEqual([])
    const visible = await salesReader.objects.executeQuery({ query: search("Alpha") })
    expect(visible.objects.map((row) => row.primaryId)).toEqual(["inv-1"])

    const cleared = await financeReader.objects.executeQuery({ query: search("bonus-word") })
    expect(cleared.objects.map((row) => row.primaryId)).toEqual(["inv-1"])
  })
})

describe("markings on writes and events", () => {
  test("an upsert returns the merged row redacted", async () => {
    const host = createHost()
    const { salesReader } = await seed(host)
    // Writes record their requester, so it must exist.
    await host.storage.auth?.users.create({
      projectId,
      id: "user-sales",
      email: "sales@example.com",
    })

    const written = await salesReader.objects.upsert(Invoice.id, { id: "inv-1", title: "Gamma" })
    expect(written.properties).toEqual({ id: "inv-1", title: "Gamma" })
    expect(written.redactions).toMatchObject({ amount: { reason: "missing_clearance" } })

    const [batched] = await salesReader.objects.upsertBatch(Invoice.id, [
      { properties: { id: "inv-1", title: "Delta" } },
    ])
    expect(batched).toMatchObject({
      ok: true,
      value: { properties: { id: "inv-1", title: "Delta" } },
    })
    expect(batched?.ok && batched.value.properties.amount).toBeUndefined()
  })

  test("object events omit marked properties from properties and changes", async () => {
    const host = createHost()
    const { salesReader, financeReader } = await seed(host)

    const created = (await salesReader.events.read()).find(
      (event) => event.type === "object.created" && event.payload.primaryId === "inv-1"
    )
    expect(created?.type).toBe("object.created")
    if (created?.type !== "object.created") return
    expect(created.payload.properties).toEqual({ id: "inv-1", title: "Alpha" })
    expect(Object.keys(created.payload.propertyChanges).sort()).toEqual(["id", "title"])
    expect(created.payload.redactions).toMatchObject({ amount: { reason: "missing_clearance" } })

    const cleared = (await financeReader.events.read()).find(
      (event) => event.type === "object.created" && event.payload.primaryId === "inv-1"
    )
    expect(cleared?.type === "object.created" && cleared.payload.properties.amount).toBe(120)
  })
})

describe("markings on other read paths", () => {
  test("property readability reflects clearances", async () => {
    const host = createHost()
    const reader = createAuthorizedObjectReader({
      scope: createTestingScope({ projectId, context: contextFor(host, ["sales"]) }),
      ontology: host.definitions.ontology as OntologyRegistry,
      objectStorage: host.storage.objects,
    })
    const item = { objectTypeId: Invoice.id, primaryId: "inv-1" }

    expect(await reader.canReadObjectProperty({ ...item, propertyId: "title" })).toBe(true)
    expect(await reader.canReadObjectProperty({ ...item, propertyId: "amount" })).toBe(false)
    expect(
      await reader.canReadObjectPropertiesBatch({
        items: [
          { ...item, propertyId: "amount" },
          { ...item, propertyId: "title" },
        ],
      })
    ).toEqual([false, true])
  })

  test("shared access carries no clearance", async () => {
    const host = createHost()
    await seed(host)
    const shared = host.withScope(
      createDelegatedRequestScope({
        projectId,
        requestId: "shared-request",
        correlationId: "shared-correlation",
        objectRead: {
          selection: {
            kind: "selected",
            roots: [
              {
                anchor: { objectTypeId: Invoice.id, primaryId: "inv-1" },
                node: {
                  objects: [
                    { objectTypeId: Invoice.id, propertyIds: ["id", "title", "notes", "amount"] },
                  ],
                  links: [],
                },
              },
            ],
          },
          limits: { maxTraversalFacts: 10, maxOutputJsonBytes: 10_000 },
        },
      })
    )

    const invoice = await shared.objects.get(Invoice.id, "inv-1")
    expect(invoice?.properties).toEqual({ id: "inv-1", title: "Alpha" })
    expect(invoice?.redactions).toMatchObject({ amount: { reason: "missing_clearance" } })
    await expect(
      shared.objects.executeQuery({
        query: { kind: "text", input: invoices, query: "bonus-word" },
      })
    ).resolves.toMatchObject({ objects: [] })
  })
})

describe("markings at startup", () => {
  const Plain = (properties: Parameters<typeof defineObjectType>[0]["properties"]) =>
    defineObjectType({ id: "plain", name: "Plain", properties })
  const start = (input: Partial<ConstructorParameters<typeof SixbHost>[0]>) => () =>
    new SixbHost({
      id: projectId,
      ontology: [],
      markings: [financial],
      ...createTestRuntimeDeps(),
      ...input,
    })

  test("a property may only reference registered markings", () => {
    expect(
      start({
        ontology: [
          Plain([
            prop("id", "string", { required: true, primary: true }),
            prop("x", "string", { markings: [pii] }),
          ]),
        ],
      })
    ).toThrow(
      "[Sixb] Property 'plain.x' references unknown marking 'pii'. Add it to 'security/markings/' or pass it to createSixb({ markings })."
    )
  })

  test("primary, telemetry, and link properties cannot be marked", () => {
    expect(
      start({
        ontology: [
          Plain([prop("id", "string", { required: true, primary: true, markings: [financial] })]),
        ],
      })
    ).toThrow("[Sixb] Primary property 'plain.id' cannot carry markings: it identifies the object.")
    expect(
      start({
        ontology: [
          Plain([
            prop("id", "string", { required: true, primary: true }),
            prop("t", "double", { mode: "telemetry", markings: [financial] }),
          ]),
        ],
      })
    ).toThrow("[Sixb] Telemetry property 'plain.t' cannot carry markings yet.")
    const Target = defineObjectType({
      id: "target",
      name: "Target",
      properties: [prop("id", "string", { required: true, primary: true })],
    })
    const Source = defineObjectType({
      id: "source",
      name: "Source",
      properties: [prop("id", "string", { required: true, primary: true })],
      links: [
        link("target", Target, { properties: [prop("note", "string", { markings: [financial] })] }),
      ],
    })
    expect(start({ ontology: [Target, Source] })).toThrow(
      "[Sixb] Link property 'source.target.note' cannot carry markings. Mark object properties instead."
    )
  })

  test("a subtype cannot drop a marking by redefining the property", () => {
    const Parent = defineObjectType({
      id: "parent",
      name: "Parent",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("amount", "double", { markings: [financial] }),
      ],
    })
    const Child = defineObjectType({
      id: "child",
      name: "Child",
      extends: Parent,
      properties: [prop("amount", "double")],
    })
    expect(start({ ontology: [Parent, Child] })).toThrow(
      "[Sixb] Property 'child.amount' must keep the markings of 'parent.amount': add 'financial'."
    )
  })

  test("roles may only clear registered markings", () => {
    const team = defineGroup("team")
    const role = defineRole("auditor", { grantedTo: [team], clearances: [pii] })
    expect(start({ groups: [team], roles: [role] })).toThrow(
      "[Sixb] Role 'auditor' clearances reference unknown marking 'pii'. Add it to 'security/markings/' or pass it to createSixb({ markings })."
    )
    expect(() => defineRole("empty", { grantedTo: [team] })).toThrow(
      "[Sixb] Role 'empty' must declare at least one grant or clearance."
    )
  })

  test("marking ids are unique", () => {
    expect(start({ markings: [financial, defineMarking("financial")] })).toThrow(
      "[Sixb] Duplicate marking id: financial"
    )
  })
})
