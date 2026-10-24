import { describe, expect, test } from "bun:test"
import type { JsonValue } from "../json"
import {
  executeObjectQuery,
  type ObjectQuery,
  type ObjectQueryPredicate,
  validateObjectQuery,
} from "../objects/query"
import { defineObjectType, link, OntologyRegistry, prop } from "../ontology"
import { migrateStorage } from "../storage/migrations"
import {
  compileConditionalObjectReadScope,
  linkBatchKey,
  type ObjectReadCondition,
  type ObjectReadScopeFactory,
  type ObjectReadStorage,
  objectBatchKey,
} from "../storage/objects"
import type { Storage } from "../storage/types"
import {
  createMaterializerTestFixture,
  type MaterializerFixtureLink,
  type MaterializerFixtureObject,
  type MaterializerTestFixture,
} from "./materializer-fixture"
import type {
  ObjectReadScopeContractHarness,
  ObjectReadScopeContractSuiteOptions,
} from "./object-read-scope-contract"

const projectId = "conditional-read-scope-contract"
const otherProjectId = "conditional-read-scope-contract-other"

const Invoice = defineObjectType({
  id: "ConditionInvoice",
  name: "Condition Invoice",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("status", "string", { query: { searchable: true, filterable: true, facet: true } }),
    prop("amount", "double", { query: { searchable: true, filterable: true, sortable: true } }),
    prop("title", "string", { query: { searchable: true, text: true } }),
    prop("code", "string", { unique: true }),
  ],
  links: [link.self("related")],
  search: { defaultText: ["title"] },
})

/** Inherits every property of an invoice, but is its own concrete type. */
const CreditNote = defineObjectType({
  id: "ConditionCreditNote",
  name: "Condition Credit Note",
  extends: Invoice,
  properties: [],
})

const Customer = defineObjectType({
  id: "ConditionCustomer",
  name: "Condition Customer",
  properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
  links: [link("invoices", Invoice)],
})

const ontology = new OntologyRegistry({ sources: [Invoice, CreditNote, Customer] })

/**
 * Portable conditional-read contract shared by every storage provider.
 *
 * A condition hides the objects of its concrete type it does not match, and every link touching
 * one, from every read: hidden rows behave exactly like missing ones, before filters, ordering,
 * pagination and aggregates.
 */
export function runConditionalObjectReadScopeContractSuite<TStorage extends Storage>(
  label: string,
  options: ObjectReadScopeContractSuiteOptions<TStorage>
): void {
  const withHarness = async (
    body: (context: {
      readonly harness: ObjectReadScopeContractHarness<TStorage>
      readonly fixture: MaterializerTestFixture
    }) => Promise<void>
  ): Promise<void> => {
    const harness = await options.createHarness()
    try {
      await migrateStorage(harness.storage, { projectId, ontology })
      const fixture = createMaterializerTestFixture({
        projectId,
        ontology,
        storage: harness.storage,
      })
      await seed(fixture)
      await body({ harness, fixture })
    } finally {
      await options.teardown?.(harness)
    }
  }

  describe(label, () => {
    test("hides the objects a condition does not match from every object read", async () => {
      await withHarness(async ({ harness }) => {
        const reader = createReader(harness.objectReadScopeFactory, [noDrafts(Invoice.id)])

        expect(await reader.getByPrimaryId(invoiceRef("inv-1"))).toMatchObject({
          primaryId: "inv-1",
          properties: { status: "paid" },
        })
        expect(await reader.getByPrimaryId(invoiceRef("inv-2"))).toBeNull()

        const batch = await reader.getByPrimaryIdBatch({
          projectId,
          items: [
            { objectTypeId: Invoice.id, primaryId: "inv-2" },
            { objectTypeId: Invoice.id, primaryId: "inv-3" },
            { objectTypeId: Customer.id, primaryId: "cust-1" },
          ],
        })
        expect([...batch.keys()]).toEqual([
          objectBatchKey(Invoice.id, "inv-3"),
          objectBatchKey(Customer.id, "cust-1"),
        ])

        expect(
          await reader.selectsObjectProperties({
            projectId,
            items: [
              { objectTypeId: Invoice.id, primaryId: "inv-1", propertyId: "status" },
              { objectTypeId: Invoice.id, primaryId: "inv-2", propertyId: "status" },
              { objectTypeId: Invoice.id, primaryId: "inv-1", propertyId: "unset" },
            ],
          })
        ).toEqual([true, false, true])

        const byCode = (valueKey: string) =>
          reader.getByUniqueValue({
            projectId,
            objectTypeId: Invoice.id,
            propertyId: "code",
            valueKey,
          })
        expect(await byCode("A-1")).toMatchObject({ primaryId: "inv-1" })
        expect(await byCode("B-2")).toBeNull()

        const firstPage = await reader.list({
          projectId,
          objectTypeId: Invoice.id,
          orderBy: "primaryId",
          order: "asc",
          limit: 1,
        })
        expect(firstPage).toMatchObject({ total: 2, hasMore: true })
        expect(firstPage.objects.map((row) => row.primaryId)).toEqual(["inv-1"])

        const secondPage = await reader.list({
          projectId,
          objectTypeId: Invoice.id,
          orderBy: "primaryId",
          order: "asc",
          limit: 1,
          offset: 1,
        })
        expect(secondPage).toMatchObject({ total: 2, hasMore: false })
        expect(secondPage.objects.map((row) => row.primaryId)).toEqual(["inv-3"])

        const everything = await reader.list({ projectId, orderBy: "primaryId", order: "asc" })
        expect(everything.objects.map((row) => row.primaryId)).toEqual([
          "cn-1",
          "cust-1",
          "inv-1",
          "inv-3",
        ])
        expect(everything.total).toBe(4)
      })
    })

    test("applies conditions before filters, ordering, pagination and aggregates", async () => {
      await withHarness(async ({ harness }) => {
        const reader = createReader(harness.objectReadScopeFactory, [noDrafts(Invoice.id)])
        const query = (value: ObjectQuery) => reader.queryObjects?.({ projectId, query: value })
        const ids = (result: Awaited<ReturnType<typeof query>>) =>
          result?.objects.map((row) => row.primaryId)
        const byId = sorted({ kind: "start", objectTypeId: Invoice.id }, "id")

        expect(await query({ kind: "start", objectTypeId: Invoice.id })).toMatchObject({
          total: 2,
          hasMore: false,
        })
        expect(
          ids(
            await query({
              kind: "filter",
              input: { kind: "start", objectTypeId: Invoice.id },
              predicate: { op: "gte", propertyId: "amount", value: 15 },
            })
          )
        ).toEqual(["inv-3"])
        expect(
          ids(
            await query({
              kind: "refs",
              refs: [
                { objectTypeId: Invoice.id, primaryId: "inv-2" },
                { objectTypeId: Invoice.id, primaryId: "inv-1" },
              ],
            })
          )
        ).toEqual(["inv-1"])
        expect(
          ids(
            await query({
              kind: "text",
              input: { kind: "start", objectTypeId: Invoice.id },
              query: "invoice",
              fields: ["title"],
            })
          )?.sort()
        ).toEqual(["inv-1", "inv-3"])

        const limited = await query({
          kind: "limit",
          limit: 1,
          input: sorted({ kind: "start", objectTypeId: Invoice.id }, "amount", "desc"),
        })
        expect(limited).toMatchObject({ total: 2, hasMore: true })
        expect(ids(limited)).toEqual(["inv-3"])

        const firstPage = await query({ kind: "page", pageSize: 1, input: byId })
        expect(firstPage).toMatchObject({ total: 2, hasMore: true })
        expect(ids(firstPage)).toEqual(["inv-1"])

        const secondPage = await query({
          kind: "page",
          pageSize: 1,
          pageToken: firstPage?.nextPageToken,
          input: byId,
        })
        expect(secondPage).toMatchObject({ hasMore: false })
        expect(ids(secondPage)).toEqual(["inv-3"])

        expect(
          await reader.countObjects?.({
            projectId,
            query: { kind: "start", objectTypeId: Invoice.id },
          })
        ).toEqual({ count: 2 })
        expect(
          await reader.existsObjects?.({
            projectId,
            query: {
              kind: "filter",
              input: { kind: "start", objectTypeId: Invoice.id },
              predicate: { op: "eq", propertyId: "status", value: "draft" },
            },
          })
        ).toEqual({ exists: false })
        expect(
          await reader.facetObjects?.({
            projectId,
            query: { kind: "start", objectTypeId: Invoice.id },
            facets: [{ propertyId: "status", limit: 10 }],
          })
        ).toEqual({
          total: 2,
          facets: [
            {
              propertyId: "status",
              buckets: [
                { value: "paid", count: 1 },
                { value: "sent", count: 1 },
              ],
            },
          ],
        })
      })
    })

    test("hides every link to a hidden endpoint, in both directions", async () => {
      await withHarness(async ({ harness }) => {
        const reader = createReader(harness.objectReadScopeFactory, [noDrafts(Invoice.id)])
        const targets = (links: readonly { targetId: string }[]) =>
          links.map((row) => row.targetId).sort()
        const related = (primaryId: string, direction: "outgoing" | "incoming" | "both") =>
          reader.listLinks({
            projectId,
            objectTypeId: Invoice.id,
            objectId: primaryId,
            linkId: "related",
            direction,
          })

        expect(targets(await related("inv-1", "outgoing"))).toEqual(["inv-3"])
        expect(await related("inv-1", "incoming")).toEqual([])
        expect(targets(await related("inv-1", "both"))).toEqual(["inv-3"])
        expect(await related("inv-2", "both")).toEqual([])
        expect(
          targets(
            await reader.listLinks({ projectId, objectTypeId: Customer.id, objectId: "cust-1" })
          )
        ).toEqual(["inv-1", "inv-3"])

        const outgoing = await reader.listLinksBatch({
          projectId,
          direction: "outgoing",
          items: [{ objectTypeId: Customer.id, objectId: "cust-1", linkId: "invoices" }],
        })
        expect(
          targets(outgoing.get(linkBatchKey(Customer.id, "cust-1", "invoices")) ?? [])
        ).toEqual(["inv-1", "inv-3"])

        const incoming = await reader.listLinksBatch({
          projectId,
          direction: "incoming",
          items: [
            { objectTypeId: Invoice.id, objectId: "inv-2", linkId: "invoices" },
            { objectTypeId: Invoice.id, objectId: "inv-3", linkId: "invoices" },
          ],
        })
        expect([...incoming.keys()]).toEqual([linkBatchKey(Invoice.id, "inv-3", "invoices")])

        const firstPage = await reader.queryLinks({
          projectId,
          objectRefs: [{ objectTypeId: Customer.id, primaryId: "cust-1" }],
          direction: "outgoing",
          limit: 1,
        })
        expect(firstPage.hasMore).toBe(true)
        expect(targets(firstPage.links)).toEqual(["inv-1"])

        const last = firstPage.links[0]
        if (!last) throw new Error("expected a first link page")
        const secondPage = await reader.queryLinks({
          projectId,
          objectRefs: [{ objectTypeId: Customer.id, primaryId: "cust-1" }],
          direction: "outgoing",
          after: [last.sourceTypeId, last.sourceId, last.linkId, last.targetTypeId, last.targetId],
          limit: 1,
        })
        expect(secondPage.hasMore).toBe(false)
        expect(targets(secondPage.links)).toEqual(["inv-3"])
      })
    })

    test("traverses and expands into a conditioned type in both directions", async () => {
      await withHarness(async ({ harness }) => {
        const reader = createReader(harness.objectReadScopeFactory, [noDrafts(Invoice.id)])
        const invoicesOf = await reader.queryObjects?.({
          projectId,
          query: sorted(
            {
              kind: "traverse",
              direction: "outgoing",
              linkId: "invoices",
              input: { kind: "start", objectTypeId: Customer.id },
            },
            "id"
          ),
        })
        expect(invoicesOf?.objects.map((row) => row.primaryId)).toEqual(["inv-1", "inv-3"])
        expect(invoicesOf?.total).toBe(2)

        const customersOf = (primaryId: string) =>
          reader.queryObjects?.({
            projectId,
            query: {
              kind: "traverse",
              direction: "incoming",
              linkId: "invoices",
              sourceObjectTypeId: Customer.id,
              input: { kind: "refs", refs: [{ objectTypeId: Invoice.id, primaryId }] },
            },
          })
        expect((await customersOf("inv-1"))?.objects.map((row) => row.primaryId)).toEqual([
          "cust-1",
        ])
        expect((await customersOf("inv-2"))?.objects).toEqual([])

        const expanded = await executeObjectQuery(
          {
            projectId,
            query: {
              kind: "expand",
              input: {
                kind: "limit",
                limit: 10,
                input: { kind: "start", objectTypeId: Customer.id },
              },
              expansions: [{ linkId: "invoices", direction: "outgoing" }],
            },
          },
          { ontology, storage: reader }
        )
        const invoices = expanded.objects[0]?.links?.invoices
        if (!Array.isArray(invoices)) throw new Error("expected expanded invoices")
        expect(invoices.map((row) => row.primaryId).sort()).toEqual(["inv-1", "inv-3"])
      })
    })

    test("applies a condition to its concrete type only", async () => {
      await withHarness(async ({ harness }) => {
        const invoicesOnly = createReader(harness.objectReadScopeFactory, [noDrafts(Invoice.id)])
        expect(await invoicesOnly.getByPrimaryId(creditNoteRef)).toMatchObject({
          properties: { status: "draft" },
        })

        const creditNotesOnly = createReader(harness.objectReadScopeFactory, [
          noDrafts(CreditNote.id),
        ])
        expect(await creditNotesOnly.getByPrimaryId(creditNoteRef)).toBeNull()
        expect(await creditNotesOnly.getByPrimaryId(invoiceRef("inv-2"))).toMatchObject({
          properties: { status: "draft" },
        })
        expect(
          await creditNotesOnly.countObjects?.({
            projectId,
            query: { kind: "start", objectTypeId: Invoice.id },
          })
        ).toEqual({ count: 3 })
      })
    })

    test("hides a whole type behind a constant false condition", async () => {
      await withHarness(async ({ harness }) => {
        const reader = createReader(harness.objectReadScopeFactory, [
          { objectTypeId: Invoice.id, predicate: { op: "constant", value: false } },
        ])

        expect(await reader.getByPrimaryId(invoiceRef("inv-1"))).toBeNull()
        expect(await reader.list({ projectId, objectTypeId: Invoice.id })).toEqual({
          objects: [],
          hasMore: false,
          total: 0,
        })
        expect(
          await reader.countObjects?.({
            projectId,
            query: { kind: "start", objectTypeId: Invoice.id },
          })
        ).toEqual({ count: 0 })
        expect(await reader.getByPrimaryId(customerRef)).toMatchObject({ primaryId: "cust-1" })
        expect(
          await reader.listLinks({
            projectId,
            objectTypeId: Customer.id,
            objectId: "cust-1",
          })
        ).toEqual([])
      })
    })

    test("never reads another project's objects or links", async () => {
      await withHarness(async ({ harness }) => {
        await migrateStorage(harness.storage, { projectId: otherProjectId, ontology })
        await createMaterializerTestFixture({
          projectId: otherProjectId,
          ontology,
          storage: harness.storage,
        }).seed({
          objects: [
            invoice("inv-1", { status: "paid" }),
            invoice("inv-9", { status: "paid" }),
            object(Customer.id, "cust-9", { id: "cust-9" }),
          ],
          links: [
            linkRow(Customer.id, "cust-9", "invoices", Invoice.id, "inv-1"),
            linkRow(Invoice.id, "inv-9", "related", Invoice.id, "inv-1"),
          ],
        })

        const edges = (links: readonly { sourceId: string; targetId: string }[]) =>
          links.map((row) => `${row.sourceId}>${row.targetId}`).sort()

        for (const [conditions, incoming] of [
          [[], ["cust-1>inv-1", "inv-2>inv-1"]],
          [[noDrafts(Invoice.id)], ["cust-1>inv-1"]],
        ] as const) {
          const reader = createReader(harness.objectReadScopeFactory, conditions)

          expect(
            edges(
              await reader.listLinks({
                projectId,
                objectTypeId: Invoice.id,
                objectId: "inv-1",
                direction: "incoming",
              })
            )
          ).toEqual([...incoming])

          const both = await reader.queryLinks({
            projectId,
            objectRefs: [{ objectTypeId: Invoice.id, primaryId: "inv-1" }],
            direction: "both",
            limit: 10,
          })
          expect(edges(both.links).filter((edge) => edge.endsWith(">inv-1"))).toEqual([...incoming])
        }
      })
    })

    test("lists nothing for a type id no object has", async () => {
      await withHarness(async ({ harness }) => {
        for (const conditions of [[], [noDrafts(Invoice.id)]]) {
          const reader = createReader(harness.objectReadScopeFactory, conditions)

          expect(await reader.list({ projectId, objectTypeId: "" })).toEqual({
            objects: [],
            hasMore: false,
            total: 0,
          })
        }
      })
    })

    test("reads live rows and stays bound to its project", async () => {
      await withHarness(async ({ harness, fixture }) => {
        const reader = createReader(harness.objectReadScopeFactory, [noDrafts(Invoice.id)])

        await fixture.commit([
          {
            id: "publish-inv-2",
            kind: "object.patch",
            ref: invoiceRef("inv-2"),
            set: { status: "sent" },
            unset: [],
            reset: [],
          },
          {
            id: "draft-inv-1",
            kind: "object.patch",
            ref: invoiceRef("inv-1"),
            set: { status: "draft" },
            unset: [],
            reset: [],
          },
        ])
        expect(await reader.getByPrimaryId(invoiceRef("inv-2"))).toMatchObject({
          primaryId: "inv-2",
        })
        expect(await reader.getByPrimaryId(invoiceRef("inv-1"))).toBeNull()

        const crossProject = await reader
          .list({ projectId: otherProjectId })
          .catch((error: unknown) => error)
        expect(String(crossProject)).toContain(`belongs to project '${projectId}'`)
      })
    })
  })
}

function createReader(
  factory: ObjectReadScopeFactory,
  conditions: readonly ObjectReadCondition[]
): ObjectReadStorage {
  return factory.createConditionalReadScope({
    projectId,
    scope: compileConditionalObjectReadScope({ kind: "conditional", conditions }),
  })
}

/** `status neq "draft"`, validated like a grant's condition so `scalarKind` is resolved. */
function noDrafts(objectTypeId: string): ObjectReadCondition {
  const predicate: ObjectQueryPredicate = { op: "neq", propertyId: "status", value: "draft" }
  const { query } = validateObjectQuery(
    { kind: "filter", input: { kind: "start", objectTypeId }, predicate },
    { ontology }
  )
  if (query.kind !== "filter") throw new Error("expected a validated filter")

  return { objectTypeId, predicate: query.predicate }
}

function sorted(
  input: ObjectQuery,
  propertyId: string,
  direction: "asc" | "desc" = "asc"
): ObjectQuery {
  return { kind: "sort", fields: [{ kind: "property", propertyId, direction }], input }
}

function invoiceRef(primaryId: string) {
  return { projectId, objectTypeId: Invoice.id, primaryId }
}

const customerRef = { projectId, objectTypeId: Customer.id, primaryId: "cust-1" }
const creditNoteRef = { projectId, objectTypeId: CreditNote.id, primaryId: "cn-1" }

async function seed(fixture: MaterializerTestFixture): Promise<void> {
  await fixture.seed({
    objects: [
      invoice("inv-1", { status: "paid", amount: 10, title: "Alpha invoice", code: "A-1" }),
      invoice("inv-2", { status: "draft", amount: 20, title: "Beta invoice", code: "B-2" }),
      invoice("inv-3", { status: "sent", amount: 30, title: "Gamma invoice", code: "C-3" }),
      object(CreditNote.id, "cn-1", { id: "cn-1", status: "draft", amount: 5 }),
      object(Customer.id, "cust-1", { id: "cust-1", name: "Acme" }),
    ],
    links: [
      linkRow(Customer.id, "cust-1", "invoices", Invoice.id, "inv-1"),
      linkRow(Customer.id, "cust-1", "invoices", Invoice.id, "inv-2"),
      linkRow(Customer.id, "cust-1", "invoices", Invoice.id, "inv-3"),
      linkRow(Invoice.id, "inv-1", "related", Invoice.id, "inv-2"),
      linkRow(Invoice.id, "inv-2", "related", Invoice.id, "inv-1"),
      linkRow(Invoice.id, "inv-1", "related", Invoice.id, "inv-3"),
    ],
  })
}

function invoice(
  primaryId: string,
  properties: Readonly<Record<string, JsonValue>>
): MaterializerFixtureObject {
  return object(Invoice.id, primaryId, { id: primaryId, ...properties })
}

function object(
  objectTypeId: string,
  primaryId: string,
  properties: Readonly<Record<string, JsonValue>>
): MaterializerFixtureObject {
  return { ref: { objectTypeId, primaryId }, properties }
}

function linkRow(
  sourceObjectTypeId: string,
  sourcePrimaryId: string,
  linkId: string,
  targetObjectTypeId: string,
  targetPrimaryId: string
): MaterializerFixtureLink {
  return {
    ref: {
      source: { objectTypeId: sourceObjectTypeId, primaryId: sourcePrimaryId },
      linkId,
      target: { objectTypeId: targetObjectTypeId, primaryId: targetPrimaryId },
    },
  }
}
