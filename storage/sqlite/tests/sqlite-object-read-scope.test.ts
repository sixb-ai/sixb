import { Database, type SQLQueryBindings } from "bun:sqlite"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineObjectType, link, migrateStorage, OntologyRegistry, prop } from "@sixb/core"
import type { ExpandedObjectRow, ObjectReadScope, ObjectReadStorage } from "@sixb/core/storage"
import { createMaterializerTestFixture } from "@sixb/core/testing"
import { SqliteStorage } from "../src"
import { sqliteStoragePath } from "../src/migrations"
import { SqliteObjectStorage } from "../src/object-storage"

const Product = defineObjectType({
  id: "ScopedProduct",
  name: "Scoped Product",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("label", "string", { query: { searchable: true, facet: true, sortable: true } }),
    prop("secret", "string", { query: { searchable: true, facet: true, sortable: true } }),
  ],
})

const Item = defineObjectType({
  id: "ScopedItem",
  name: "Scoped Item",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { query: { searchable: true, facet: true, sortable: true } }),
    prop("secret", "string"),
  ],
  links: [link("product", Product, { cardinality: "one" })],
})

const Proposal = defineObjectType({
  id: "ScopedProposal",
  name: "Scoped Proposal",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("title", "string", { query: { searchable: true, facet: true, sortable: true } }),
    prop("summary", "string"),
    prop("approved", "boolean", { query: { searchable: true, facet: true } }),
    prop("secret", "string", { query: { searchable: true, facet: true, sortable: true } }),
  ],
  links: [
    link("items", Item, {
      cardinality: "many",
      properties: [
        prop("position", "integer"),
        prop("featured", "boolean"),
        prop("note", "string"),
      ],
    }),
    link("secondary", Item, {
      cardinality: "many",
      properties: [prop("internal", "string")],
    }),
    link("privateProduct", Product, { cardinality: "one" }),
  ],
})

const ontology = new OntologyRegistry({ sources: [Product, Item, Proposal] })
const projectId = "sqlite-read-scope"
const defaultReaderLimits = Object.freeze({
  maxTraversalFacts: 10_000,
  maxVisibleJsonBytes: 8 * 1024 * 1024,
})

async function selectsObjectProperty(
  reader: Pick<ObjectReadStorage, "selectsObjectProperties">,
  input: {
    readonly projectId: string
    readonly objectTypeId: string
    readonly primaryId: string
    readonly propertyId: string
  }
): Promise<boolean> {
  const [selected] = await reader.selectsObjectProperties({
    projectId: input.projectId,
    items: [input],
  })
  return selected ?? false
}

const readScope: ObjectReadScope = {
  kind: "selected",
  roots: [
    {
      anchor: { objectTypeId: Proposal.id, primaryId: "proposal-z" },
      node: {
        objects: [
          {
            objectTypeId: Proposal.id,
            propertyIds: ["id", "summary", "title", "approved"],
          },
        ],
        links: [
          {
            definitions: [
              {
                sourceObjectTypeId: Proposal.id,
                linkId: "items",
                targetObjectTypeIds: [Item.id],
                propertyIds: ["position", "featured"],
              },
            ],
            target: {
              objects: [{ objectTypeId: Item.id, propertyIds: ["id", "name"] }],
              links: [
                {
                  definitions: [
                    {
                      sourceObjectTypeId: Item.id,
                      linkId: "product",
                      targetObjectTypeIds: [Product.id],
                      propertyIds: [],
                    },
                  ],
                  target: {
                    objects: [{ objectTypeId: Product.id, propertyIds: ["id", "label"] }],
                    links: [],
                  },
                },
              ],
            },
          },
          {
            definitions: [
              {
                sourceObjectTypeId: Proposal.id,
                linkId: "secondary",
                targetObjectTypeIds: [Item.id],
                propertyIds: [],
              },
            ],
            target: {
              objects: [{ objectTypeId: Item.id, propertyIds: ["id", "name"] }],
              links: [],
            },
          },
        ],
      },
    },
  ],
}

let storage: SqliteStorage
let addLiveItemLink: () => Promise<void>
let removeLiveItemLink: () => Promise<void>

beforeAll(async () => {
  storage = new SqliteStorage()
  const fixture = createMaterializerTestFixture({ projectId, ontology, storage })
  const liveItemRef = {
    source: { objectTypeId: Proposal.id, primaryId: "proposal-z" },
    linkId: "items",
    target: { objectTypeId: Item.id, primaryId: "item-live" },
  } as const
  addLiveItemLink = async () => {
    await fixture.seed({ links: [{ ref: liveItemRef, properties: { position: 3 } }] })
  }
  removeLiveItemLink = async () => {
    await fixture.commit([{ id: "remove-live-item", kind: "link.delete", ref: liveItemRef }])
  }
  await fixture.seed({
    objects: [
      {
        ref: { objectTypeId: Proposal.id, primaryId: "proposal-a" },
        properties: {
          id: "proposal-a",
          title: "A unauthorized",
          approved: false,
          secret: "proposal-a-secret",
        },
      },
      {
        ref: { objectTypeId: Proposal.id, primaryId: "proposal-z" },
        properties: {
          id: "proposal-z",
          title: "Z authorized",
          approved: true,
          secret: "proposal-z-secret",
        },
      },
      {
        ref: { objectTypeId: Item.id, primaryId: "item-a" },
        properties: { id: "item-a", name: "A unauthorized", secret: "item-a-secret" },
      },
      {
        ref: { objectTypeId: Item.id, primaryId: "item-branch" },
        properties: { id: "item-branch", name: "Branch only", secret: "branch-secret" },
      },
      {
        ref: { objectTypeId: Item.id, primaryId: "item-z" },
        properties: { id: "item-z", name: "Z authorized", secret: "item-z-secret" },
      },
      {
        ref: { objectTypeId: Item.id, primaryId: "item-live" },
        properties: { id: "item-live", name: "Live item", secret: "live-secret" },
      },
      {
        ref: { objectTypeId: Product.id, primaryId: "product-a" },
        properties: { id: "product-a", label: "A unauthorized", secret: "product-a-secret" },
      },
      {
        ref: { objectTypeId: Product.id, primaryId: "product-branch" },
        properties: {
          id: "product-branch",
          label: "Branch must stay hidden",
          secret: "product-branch-secret",
        },
      },
      {
        ref: { objectTypeId: Product.id, primaryId: "product-z" },
        properties: { id: "product-z", label: "Z authorized", secret: "product-z-secret" },
      },
    ],
    links: [
      {
        ref: {
          source: { objectTypeId: Proposal.id, primaryId: "proposal-a" },
          linkId: "items",
          target: { objectTypeId: Item.id, primaryId: "item-a" },
        },
        properties: { position: 1, note: "unauthorized edge" },
      },
      {
        ref: {
          source: { objectTypeId: Proposal.id, primaryId: "proposal-z" },
          linkId: "items",
          target: { objectTypeId: Item.id, primaryId: "item-z" },
        },
        properties: { position: 2, featured: true, note: "hidden edge property" },
      },
      {
        ref: {
          source: { objectTypeId: Proposal.id, primaryId: "proposal-z" },
          linkId: "secondary",
          target: { objectTypeId: Item.id, primaryId: "item-branch" },
        },
        properties: { internal: "hidden edge property" },
      },
      {
        ref: {
          source: { objectTypeId: Item.id, primaryId: "item-a" },
          linkId: "product",
          target: { objectTypeId: Product.id, primaryId: "product-a" },
        },
      },
      {
        ref: {
          source: { objectTypeId: Item.id, primaryId: "item-branch" },
          linkId: "product",
          target: { objectTypeId: Product.id, primaryId: "product-branch" },
        },
      },
      {
        ref: {
          source: { objectTypeId: Item.id, primaryId: "item-z" },
          linkId: "product",
          target: { objectTypeId: Product.id, primaryId: "product-z" },
        },
      },
      {
        ref: {
          source: { objectTypeId: Proposal.id, primaryId: "proposal-z" },
          linkId: "privateProduct",
          target: { objectTypeId: Product.id, primaryId: "product-z" },
        },
      },
    ],
  })
  const otherProjectFixture = createMaterializerTestFixture({
    projectId: `${projectId}-other`,
    ontology,
    storage,
  })
  await otherProjectFixture.seed({
    objects: [
      {
        ref: { objectTypeId: Proposal.id, primaryId: "proposal-missing" },
        properties: { id: "proposal-missing", title: "Other project only" },
      },
    ],
  })
})

afterAll(() => storage.close())

describe("SqliteObjectStorage selected reader", () => {
  test("scopes and projects direct object and link reads", async () => {
    const reader = storage.objects.createReadScope({
      projectId,
      scope: readScope,
      limits: defaultReaderLimits,
    })

    expect(
      await reader.getByPrimaryId({ projectId, objectTypeId: Proposal.id, primaryId: "proposal-a" })
    ).toBeNull()
    expect(
      await reader.getByPrimaryId({ projectId, objectTypeId: Proposal.id, primaryId: "proposal-z" })
    ).toMatchObject({
      properties: { id: "proposal-z", title: "Z authorized", approved: true },
    })

    const batch = await reader.getByPrimaryIdMany({
      projectId,
      items: [
        { objectTypeId: Proposal.id, primaryId: "proposal-a" },
        { objectTypeId: Proposal.id, primaryId: "proposal-z" },
      ],
    })
    expect(batch.map((row) => row?.primaryId ?? null)).toEqual([null, "proposal-z"])

    const links = await reader.listLinks({
      projectId,
      objectTypeId: Proposal.id,
      objectId: "proposal-z",
      direction: "both",
    })
    expect(links.map((row) => `${row.linkId}:${row.targetId}`).sort()).toEqual([
      "items:item-z",
      "secondary:item-branch",
    ])
    expect(links.find((row) => row.linkId === "items")?.properties).toEqual({
      position: 2,
      featured: true,
    })
    const secondary = links.find((row) => row.linkId === "secondary")
    expect(secondary?.properties).toBeUndefined()
    expect(secondary && Object.hasOwn(secondary, "properties")).toBe(false)

    const linksBatch = await reader.listLinksMany({
      projectId,
      items: [
        { objectTypeId: Proposal.id, objectId: "proposal-a", linkId: "items" },
        { objectTypeId: Proposal.id, objectId: "proposal-z", linkId: "items" },
      ],
    })
    expect(linksBatch.map((links) => links.length)).toEqual([0, 1])

    const incomingBatch = await reader.listLinksMany({
      projectId,
      direction: "incoming",
      items: [
        { objectTypeId: Item.id, objectId: "item-a", linkId: "items" },
        { objectTypeId: Item.id, objectId: "item-z", linkId: "items" },
        { objectTypeId: Item.id, objectId: "item-z", linkId: "items" },
      ],
    })
    expect(incomingBatch.map((links) => links.length)).toEqual([0, 1, 1])
    expect(incomingBatch[1]?.[0]).toMatchObject({
      sourceTypeId: Proposal.id,
      sourceId: "proposal-z",
      properties: { position: 2, featured: true },
    })
  })

  test("checks property selection independently from its materialized value", async () => {
    // Regression guard: checking `json_type(_sixb_scope_objects.properties, ...)` instead of the
    // selection relation makes the selected-but-absent `summary` assertion fail.
    const reader = storage.objects.createReadScope({
      projectId,
      scope: readScope,
      limits: defaultReaderLimits,
    })
    const input = {
      projectId,
      objectTypeId: Proposal.id,
      primaryId: "proposal-z",
    }

    expect(await selectsObjectProperty(reader, { ...input, propertyId: "title" })).toBe(true)
    expect(await selectsObjectProperty(reader, { ...input, propertyId: "summary" })).toBe(true)
    expect(await selectsObjectProperty(reader, { ...input, propertyId: "secret" })).toBe(false)
    expect(
      await selectsObjectProperty(reader, {
        ...input,
        primaryId: "proposal-a",
        propertyId: "title",
      })
    ).toBe(false)
    expect(
      await selectsObjectProperty(reader, {
        ...input,
        primaryId: "proposal-missing",
        propertyId: "title",
      })
    ).toBe(false)

    expect(await selectsObjectProperty(storage.objects, { ...input, propertyId: "secret" })).toBe(
      true
    )
    expect(
      await selectsObjectProperty(storage.objects, {
        ...input,
        primaryId: "proposal-missing",
        propertyId: "summary",
      })
    ).toBe(false)

    expect(
      await reader.selectsObjectProperties({
        projectId,
        items: [
          { objectTypeId: Proposal.id, primaryId: "proposal-z", propertyId: "summary" },
          { objectTypeId: Product.id, primaryId: "product-z", propertyId: "label" },
          { objectTypeId: Product.id, primaryId: "product-z", propertyId: "label" },
          { objectTypeId: Product.id, primaryId: "product-branch", propertyId: "label" },
          { objectTypeId: Proposal.id, primaryId: "proposal-z", propertyId: "secret" },
        ],
      })
    ).toEqual([true, true, true, false, false])
  })

  test("executes each selected batch as one data statement plus its bounded budget probe", async () => {
    const reader = storage.objects.createReadScope({
      projectId,
      scope: readScope,
      limits: defaultReaderLimits,
    })
    const holder = storage.objects as unknown as { db: SqliteQueryProbe }
    const originalDb = holder.db
    let executions = 0
    holder.db = {
      get inTransaction() {
        return originalDb.inTransaction
      },
      transaction: (run) => originalDb.transaction(run),
      query: (sql) => {
        const statement = originalDb.query(sql)
        return {
          all: (...args) => {
            executions += 1
            return statement.all(...args)
          },
          get: (...args) => {
            executions += 1
            return statement.get(...args)
          },
        }
      },
    }

    try {
      await reader.getByPrimaryIdMany({
        projectId,
        items: [
          { objectTypeId: Proposal.id, primaryId: "proposal-a" },
          { objectTypeId: Proposal.id, primaryId: "proposal-z" },
          { objectTypeId: Item.id, primaryId: "item-z" },
        ],
      })
      expect(executions).toBe(2)

      executions = 0
      await reader.listLinksMany({
        projectId,
        direction: "incoming",
        items: [
          { objectTypeId: Item.id, objectId: "item-a", linkId: "items" },
          { objectTypeId: Item.id, objectId: "item-z", linkId: "items" },
          { objectTypeId: Item.id, objectId: "item-branch", linkId: "secondary" },
        ],
      })
      expect(executions).toBe(2)

      executions = 0
      await reader.selectsObjectProperties({
        projectId,
        items: [
          { objectTypeId: Proposal.id, primaryId: "proposal-z", propertyId: "title" },
          { objectTypeId: Proposal.id, primaryId: "proposal-z", propertyId: "summary" },
          { objectTypeId: Product.id, primaryId: "product-branch", propertyId: "label" },
        ],
      })
      expect(executions).toBe(2)
    } finally {
      holder.db = originalDb
    }
  })

  test("unions property selection across every provenance reaching an object", async () => {
    const reader = storage.objects.createReadScope({
      projectId,
      limits: defaultReaderLimits,
      scope: {
        kind: "selected",
        roots: [
          {
            anchor: { objectTypeId: Proposal.id, primaryId: "proposal-z" },
            node: {
              objects: [{ objectTypeId: Proposal.id, propertyIds: ["id"] }],
              links: [],
            },
          },
          {
            anchor: { objectTypeId: Proposal.id, primaryId: "proposal-z" },
            node: {
              objects: [{ objectTypeId: Proposal.id, propertyIds: ["summary"] }],
              links: [],
            },
          },
        ],
      },
    })

    const input = { projectId, objectTypeId: Proposal.id, primaryId: "proposal-z" }
    expect(await selectsObjectProperty(reader, { ...input, propertyId: "id" })).toBe(true)
    expect(await selectsObjectProperty(reader, { ...input, propertyId: "summary" })).toBe(true)
    expect(await selectsObjectProperty(reader, { ...input, propertyId: "title" })).toBe(false)
  })

  test("applies the scope before ordering, limits, totals, counts, and facets", async () => {
    // Regression guard: replace `ctx.source.objectsTable` with raw `objects` in SQLite's
    // `compileStart`; the limit assertion below then returns proposal-a and this test fails.
    const reader = storage.objects.createReadScope({
      projectId,
      scope: readScope,
      limits: defaultReaderLimits,
    })
    const start = { kind: "start", objectTypeId: Proposal.id } as const
    const query = {
      kind: "limit",
      limit: 1,
      input: {
        kind: "sort",
        fields: [{ kind: "property", propertyId: "title", direction: "asc" }],
        input: start,
      },
    } as const

    const result = await reader.queryObjects?.({ projectId, query })
    expect(result?.objects.map((row) => row.primaryId)).toEqual(["proposal-z"])
    expect(result?.total).toBe(1)
    expect(await reader.countObjects?.({ projectId, query: start })).toEqual({ count: 1 })
    expect(await reader.existsObjects?.({ projectId, query: start })).toEqual({ exists: true })
    expect(
      await reader.facetObjects?.({
        projectId,
        query: start,
        facets: [{ propertyId: "title", limit: 10 }],
      })
    ).toEqual({
      facets: [{ propertyId: "title", buckets: [{ value: "Z authorized", count: 1 }] }],
    })
    expect(
      await reader.facetObjects?.({
        projectId,
        query: start,
        facets: [{ propertyId: "approved", limit: 10 }],
      })
    ).toEqual({
      facets: [{ propertyId: "approved", buckets: [{ value: true, count: 1 }] }],
    })

    const projected = await reader.queryObjects?.({
      projectId,
      query: { kind: "project", properties: ["approved"], input: start },
    })
    expect(projected?.objects[0]?.properties).toEqual({ approved: true })

    const listed = await reader.list({
      projectId,
      objectTypeId: Proposal.id,
      orderBy: "primaryId",
      order: "asc",
      limit: 1,
    })
    expect(listed.objects.map((row) => row.primaryId)).toEqual(["proposal-z"])
    expect(listed.total).toBe(1)

    const withoutTotal = await reader.queryObjects?.({
      projectId,
      includeTotal: false,
      query: {
        kind: "limit",
        limit: 1,
        input: { kind: "start", objectTypeId: Item.id },
      },
    })
    expect(withoutTotal?.objects).toHaveLength(1)
    expect(withoutTotal?.hasMore).toBe(true)
    expect(withoutTotal?.total).toBeUndefined()
  })

  test("applies the scope before resolving exact refs", async () => {
    const reader = storage.objects.createReadScope({
      projectId,
      scope: readScope,
      limits: defaultReaderLimits,
    })
    const refs = {
      kind: "refs",
      refs: [
        { objectTypeId: Proposal.id, primaryId: "proposal-a" },
        { objectTypeId: Item.id, primaryId: "item-z" },
        { objectTypeId: Proposal.id, primaryId: "proposal-z" },
        { objectTypeId: Item.id, primaryId: "item-a" },
      ],
    } as const

    const result = await reader.queryObjects?.({ projectId, query: refs })
    expect(result?.objects.map((row) => `${row.objectTypeId}:${row.primaryId}`)).toEqual([
      `${Item.id}:item-z`,
      `${Proposal.id}:proposal-z`,
    ])
    expect(result?.objects.map((row) => row.properties)).toEqual([
      { id: "item-z", name: "Z authorized" },
      { id: "proposal-z", title: "Z authorized", approved: true },
    ])
    expect(await reader.countObjects?.({ projectId, query: refs })).toEqual({ count: 2 })
    expect(
      await reader.existsObjects?.({
        projectId,
        query: {
          kind: "refs",
          refs: [{ objectTypeId: Proposal.id, primaryId: "proposal-a" }],
        },
      })
    ).toEqual({ exists: false })
  })

  test("hidden properties cannot participate in filters or facets", async () => {
    const reader = storage.objects.createReadScope({
      projectId,
      scope: readScope,
      limits: defaultReaderLimits,
    })
    const hiddenFilter = {
      kind: "filter",
      predicate: { op: "eq", propertyId: "secret", value: "proposal-z-secret" },
      input: { kind: "start", objectTypeId: Proposal.id },
    } as const

    expect((await reader.queryObjects?.({ projectId, query: hiddenFilter }))?.objects).toEqual([])
    expect(
      await reader.facetObjects?.({
        projectId,
        query: { kind: "start", objectTypeId: Proposal.id },
        facets: [{ propertyId: "secret", limit: 10 }],
      })
    ).toEqual({ facets: [{ propertyId: "secret", buckets: [] }] })
  })

  test("uses exact path-correlated links for traverse and nested expand", async () => {
    // Regression guard: make traversal/expansion read raw `links`; item-branch then borrows the
    // nested product grant from the sibling path and the product assertions below fail.
    const reader = storage.objects.createReadScope({
      projectId,
      scope: readScope,
      limits: defaultReaderLimits,
    })

    const outgoing = await reader.queryObjects?.({
      projectId,
      query: {
        kind: "traverse",
        direction: "outgoing",
        linkId: "product",
        input: { kind: "start", objectTypeId: Item.id },
      },
    })
    expect(outgoing?.objects.map((row) => row.primaryId)).toEqual(["product-z"])
    expect(outgoing?.objects[0]?.properties).toEqual({ id: "product-z", label: "Z authorized" })

    const incoming = await reader.queryObjects?.({
      projectId,
      query: {
        kind: "traverse",
        direction: "incoming",
        linkId: "items",
        sourceObjectTypeId: Proposal.id,
        input: { kind: "start", objectTypeId: Item.id },
      },
    })
    expect(incoming?.objects.map((row) => row.primaryId)).toEqual(["proposal-z"])

    // Both endpoints are visible through other selected paths; the physical edge itself is not.
    const privateTraversal = await reader.queryObjects?.({
      projectId,
      query: {
        kind: "traverse",
        direction: "outgoing",
        linkId: "privateProduct",
        input: { kind: "start", objectTypeId: Proposal.id },
      },
    })
    expect(privateTraversal?.objects).toEqual([])

    const expanded = await reader.queryObjects?.({
      projectId,
      query: {
        kind: "expand",
        expansions: [
          {
            linkId: "items",
            direction: "outgoing",
            cardinality: "many",
            expand: [{ linkId: "product", direction: "outgoing", cardinality: "one" }],
          },
          { linkId: "secondary", direction: "outgoing", cardinality: "many" },
        ],
        input: { kind: "start", objectTypeId: Proposal.id },
      },
    })
    const proposal = expanded?.objects[0]
    const items = proposal?.links?.items as ExpandedObjectRow[]
    const secondary = proposal?.links?.secondary as ExpandedObjectRow[]
    expect(items.map((row) => row.primaryId)).toEqual(["item-z"])
    expect(items[0]?.linkProperties).toEqual({ position: 2, featured: true })
    expect((items[0]?.links?.product as ExpandedObjectRow).primaryId).toBe("product-z")
    expect(secondary.map((row) => row.primaryId)).toEqual(["item-branch"])

    // item-branch is visible through `secondary`, but that branch did not grant its product link.
    expect(
      await reader.getByPrimaryId({
        projectId,
        objectTypeId: Product.id,
        primaryId: "product-branch",
      })
    ).toBeNull()
  })

  test("resolves link instances live for an existing reader", async () => {
    const reader = storage.objects.createReadScope({
      projectId,
      scope: readScope,
      limits: defaultReaderLimits,
    })
    const input = { projectId, objectTypeId: Item.id, primaryId: "item-live" }

    expect(await reader.getByPrimaryId(input)).toBeNull()
    expect(await selectsObjectProperty(reader, { ...input, propertyId: "name" })).toBe(false)
    await addLiveItemLink()
    expect(await reader.getByPrimaryId(input)).toMatchObject({
      properties: { id: "item-live", name: "Live item" },
    })
    expect(await selectsObjectProperty(reader, { ...input, propertyId: "name" })).toBe(true)
    expect(await selectsObjectProperty(reader, { ...input, propertyId: "secret" })).toBe(false)
    await removeLiveItemLink()
    expect(await reader.getByPrimaryId(input)).toBeNull()
    expect(await selectsObjectProperty(reader, { ...input, propertyId: "name" })).toBe(false)
  })

  test("counts only live roots and enforces the exact traversal-fact boundary per operation", async () => {
    // Regression guard: bypass `assertTraversalBudget` in SqliteObjectStorage; the limit + 1
    // assertion below stops rejecting and this test fails.
    const rootScope: ObjectReadScope = {
      kind: "selected",
      roots: [
        rootSelection(Proposal.id, "proposal-z", ["id"]),
        rootSelection(Proposal.id, "proposal-a", ["id"]),
        rootSelection(Proposal.id, "proposal-missing", ["id"]),
      ],
    }
    const exactReader = storage.objects.createReadScope({
      projectId,
      scope: rootScope,
      limits: { maxTraversalFacts: 2, maxVisibleJsonBytes: 1_000_000 },
    })

    // A root that exists only in another project is not a fact, and the budget is fresh for every
    // terminal operation.
    expect((await exactReader.list({ projectId })).total).toBe(2)
    expect((await exactReader.list({ projectId })).total).toBe(2)

    const overBudgetReader = storage.objects.createReadScope({
      projectId,
      scope: rootScope,
      limits: { maxTraversalFacts: 1, maxVisibleJsonBytes: 1_000_000 },
    })
    await expect(overBudgetReader.list({ projectId })).rejects.toMatchObject({
      code: "delegated_execution_limit_exceeded",
      metric: "traversalFacts",
      limit: 1,
    })
  })

  test("counts the same physical edge once for every selected path step", async () => {
    // Regression guard: bypass the bounded traversal probe; the limit + 1 assertion below stops
    // rejecting and this test fails.
    const itemPath = () => ({
      definitions: [
        {
          sourceObjectTypeId: Proposal.id,
          linkId: "items",
          targetObjectTypeIds: [Item.id],
          propertyIds: [] as string[],
        },
      ],
      target: {
        objects: [{ objectTypeId: Item.id, propertyIds: ["id"] }],
        links: [],
      },
    })
    const repeatedPathScope: ObjectReadScope = {
      kind: "selected",
      roots: [
        {
          anchor: { objectTypeId: Proposal.id, primaryId: "proposal-z" },
          node: {
            objects: [{ objectTypeId: Proposal.id, propertyIds: ["id"] }],
            links: [itemPath(), itemPath()],
          },
        },
      ],
    }
    const exactReader = storage.objects.createReadScope({
      projectId,
      scope: repeatedPathScope,
      limits: { maxTraversalFacts: 3, maxVisibleJsonBytes: 1_000_000 },
    })

    // One live root + the same edge selected by two distinct steps = three facts. The projected
    // object universe still contains the linked object only once.
    expect(
      (await exactReader.list({ projectId })).objects.map((row) => row.primaryId).sort()
    ).toEqual(["item-z", "proposal-z"])

    const overBudgetReader = storage.objects.createReadScope({
      projectId,
      scope: repeatedPathScope,
      limits: { maxTraversalFacts: 2, maxVisibleJsonBytes: 1_000_000 },
    })
    await expect(overBudgetReader.list({ projectId })).rejects.toMatchObject({
      code: "delegated_execution_limit_exceeded",
      metric: "traversalFacts",
      limit: 2,
    })
  })

  test("keeps the traversal probe and terminal read on one snapshot", async () => {
    // Regression guard: remove the deferred read transaction around the probe and terminal. The
    // writer injected after the probe then makes the first result contain `snapshot-item`, even
    // though that operation proved only the one-fact snapshot against its one-fact budget.
    const directory = await mkdtemp(join(tmpdir(), "sixb-sqlite-scoped-snapshot-"))
    const fileStorage = new SqliteStorage({ path: directory })
    let objectStorage: SqliteObjectStorage | undefined
    let writer: Database | undefined
    let originalDb: Database | undefined
    let holder: { db: Database } | undefined

    try {
      await migrateStorage(fileStorage)
      fileStorage.close()
      const databasePath = sqliteStoragePath(directory)
      objectStorage = new SqliteObjectStorage({ path: databasePath })
      writer = new Database(databasePath)
      writer.run("PRAGMA busy_timeout = 5000")
      const timestamp = "2026-08-28T00:00:00.000Z"
      const insertObject = writer.query(`
        INSERT INTO objects (
          project_id, object_type_id, primary_id, properties,
          created_at, updated_at, version, last_commit_id
        ) VALUES (?, ?, ?, json(?), ?, ?, 1, ?)
      `)
      insertObject.run(
        projectId,
        Proposal.id,
        "snapshot-proposal",
        JSON.stringify({ id: "snapshot-proposal" }),
        timestamp,
        timestamp,
        "snapshot-seed"
      )
      insertObject.run(
        projectId,
        Item.id,
        "snapshot-item",
        JSON.stringify({ id: "snapshot-item" }),
        timestamp,
        timestamp,
        "snapshot-seed"
      )

      const reader = objectStorage.createReadScope({
        projectId,
        limits: { maxTraversalFacts: 1, maxVisibleJsonBytes: 1_000_000 },
        scope: {
          kind: "selected",
          roots: [
            {
              anchor: { objectTypeId: Proposal.id, primaryId: "snapshot-proposal" },
              node: {
                objects: [{ objectTypeId: Proposal.id, propertyIds: ["id"] }],
                links: [
                  {
                    definitions: [
                      {
                        sourceObjectTypeId: Proposal.id,
                        linkId: "items",
                        targetObjectTypeIds: [Item.id],
                        propertyIds: [],
                      },
                    ],
                    target: {
                      objects: [{ objectTypeId: Item.id, propertyIds: ["id"] }],
                      links: [],
                    },
                  },
                ],
              },
            },
          ],
        },
      })
      holder = objectStorage as unknown as { db: Database }
      originalDb = holder.db
      let writerCommitted = false
      const probeDb = originalDb
      holder.db = {
        get inTransaction() {
          return probeDb.inTransaction
        },
        transaction: probeDb.transaction.bind(probeDb),
        query: (sql: string) => {
          const statement = probeDb.query(sql)
          return {
            all: (...args: SQLQueryBindings[]) => statement.all(...args),
            get: (...args: SQLQueryBindings[]) => {
              const result = statement.get(...args)
              if (!writerCommitted && sql.includes("bounded_traversal_facts")) {
                writerCommitted = true
                writer
                  ?.query(`
                  INSERT INTO links (
                    project_id, source_type_id, source_id, link_id, target_type_id, target_id,
                    properties, created_at, updated_at, last_commit_id
                  ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
                `)
                  .run(
                    projectId,
                    Proposal.id,
                    "snapshot-proposal",
                    "items",
                    Item.id,
                    "snapshot-item",
                    timestamp,
                    timestamp,
                    "snapshot-writer"
                  )
              }
              return result
            },
          }
        },
      } as unknown as Database

      expect((await reader.list({ projectId })).objects.map((row) => row.primaryId)).toEqual([
        "snapshot-proposal",
      ])
      expect(writerCommitted).toBe(true)

      holder.db = originalDb
      await expect(reader.list({ projectId })).rejects.toMatchObject({
        code: "delegated_execution_limit_exceeded",
        metric: "traversalFacts",
        limit: 1,
      })
    } finally {
      if (holder && originalDb) holder.db = originalDb
      writer?.close()
      objectStorage?.close()
      fileStorage.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("measures complete redacted terminal values against the visible JSON budget", async () => {
    // Regression guard: remove `assertVisibleJsonWithinLimit` from the scoped-reader wrapper; both
    // oversized terminal assertions below stop rejecting and this test fails.
    const scope: ObjectReadScope = {
      kind: "selected",
      roots: [rootSelection(Proposal.id, "proposal-z", ["id", "title"])],
    }
    const generousReader = storage.objects.createReadScope({
      projectId,
      scope,
      limits: defaultReaderLimits,
    })
    const input = {
      projectId,
      objectTypeId: Proposal.id,
      primaryId: "proposal-z",
    }
    const redacted = await generousReader.getByPrimaryId(input)
    const raw = await storage.objects.getByPrimaryId(input)
    expect(redacted?.properties).toEqual({ id: "proposal-z", title: "Z authorized" })
    expect(raw?.properties.secret).toBe("proposal-z-secret")
    const visibleBytes = utf8JsonBytes(redacted)
    expect(utf8JsonBytes(raw)).toBeGreaterThan(visibleBytes)

    const exactReader = storage.objects.createReadScope({
      projectId,
      scope,
      limits: { maxTraversalFacts: 1, maxVisibleJsonBytes: visibleBytes },
    })
    expect(await exactReader.getByPrimaryId(input)).toEqual(redacted)

    const overBudgetReader = storage.objects.createReadScope({
      projectId,
      scope,
      limits: { maxTraversalFacts: 1, maxVisibleJsonBytes: visibleBytes - 1 },
    })
    await expect(overBudgetReader.getByPrimaryId(input)).rejects.toMatchObject({
      code: "delegated_execution_limit_exceeded",
      metric: "visibleJsonBytes",
      limit: visibleBytes - 1,
    })

    // The budget covers the complete terminal value rather than each member independently.
    await expect(
      exactReader.getByPrimaryIdMany({ projectId, items: [input, input] })
    ).rejects.toMatchObject({
      code: "delegated_execution_limit_exceeded",
      metric: "visibleJsonBytes",
      limit: visibleBytes,
    })
  })

  test("rejects reuse from another project", async () => {
    const readerInput = { projectId, scope: readScope, limits: defaultReaderLimits }
    const reader = storage.objects.createReadScope(readerInput)
    readerInput.projectId = "another-project"
    await expect(
      reader.getByPrimaryId({
        projectId: "another-project",
        objectTypeId: Proposal.id,
        primaryId: "proposal-z",
      })
    ).rejects.toThrow("Object reader belongs to project")
    await expect(
      selectsObjectProperty(reader, {
        projectId: "another-project",
        objectTypeId: Proposal.id,
        primaryId: "proposal-z",
        propertyId: "title",
      })
    ).rejects.toThrow("Object reader belongs to project")
    expect((await reader.list({ projectId })).total).toBeGreaterThan(0)
  })

  test("treats an empty selected scope as an empty universe", async () => {
    const reader = storage.objects.createReadScope({
      projectId,
      limits: defaultReaderLimits,
      scope: { kind: "selected", roots: [] },
    })
    expect(await reader.list({ projectId })).toEqual({ objects: [], hasMore: false, total: 0 })
    expect(
      await selectsObjectProperty(reader, {
        projectId,
        objectTypeId: Proposal.id,
        primaryId: "proposal-z",
        propertyId: "title",
      })
    ).toBe(false)
    expect(
      await reader.queryObjects?.({
        projectId,
        query: { kind: "start", objectTypeId: Proposal.id },
      })
    ).toMatchObject({ objects: [], total: 0 })
  })
})

interface SqliteStatementProbe {
  all(...args: (string | number | boolean | null)[]): unknown[]
  get(...args: (string | number | bigint | boolean | null)[]): unknown
}

interface SqliteQueryProbe {
  readonly inTransaction: boolean
  transaction<T>(run: () => T): { deferred(): T }
  query(sql: string): SqliteStatementProbe
}

function rootSelection(objectTypeId: string, primaryId: string, propertyIds: readonly string[]) {
  return {
    anchor: { objectTypeId, primaryId },
    node: {
      objects: [{ objectTypeId, propertyIds }],
      links: [],
    },
  }
}

function utf8JsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}
