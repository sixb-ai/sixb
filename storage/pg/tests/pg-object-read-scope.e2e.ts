import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { defineObjectType, link, OntologyRegistry, prop } from "@sixb/core"
import {
  DelegatedExecutionLimitError,
  type ObjectReadScope,
  type ObjectReadStorage,
} from "@sixb/core/storage"
import { createMaterializerTestFixture } from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import { createPgClient, type SQLClient, type SqlParameter } from "../src/pg-client"
import { PgObjectStorage } from "../src/pg-object-storage"
import type { PgStoreClient } from "../src/transactions"
import { createTestStorage } from "./helpers"

const Product = defineObjectType({
  id: "ScopeProduct",
  name: "Scope Product",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string"),
    prop("internal", "string"),
  ],
})

const LineItem = defineObjectType({
  id: "ScopeLineItem",
  name: "Scope Line Item",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string"),
    prop("internal", "string"),
  ],
  links: [link("product", Product, { properties: [prop("internal", "string")] })],
})

const Proposal = defineObjectType({
  id: "ScopeProposal",
  name: "Scope Proposal",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("title", "string"),
    prop("rank", "integer"),
    prop("category", "string"),
    prop("optional", "string"),
    prop("secret", "string"),
  ],
  links: [
    link("items", LineItem, {
      properties: [prop("position", "integer"), prop("internal", "string")],
    }),
    link("reviewers", LineItem),
    link("private", Product),
  ],
})

const ontology = new OntologyRegistry({ sources: [Product, LineItem, Proposal] })
const projectId = "pg-read-scope"
const defaultReadLimits = Object.freeze({
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

let storage: PostgresStorage
let fixture: ReturnType<typeof createMaterializerTestFixture>
let schemaName: string

beforeAll(async () => {
  const testStorage = await createTestStorage()
  storage = testStorage.storage
  schemaName = testStorage.schemaName
  fixture = createMaterializerTestFixture({ projectId, ontology, storage })
  await fixture.seed({
    objects: [
      object(Proposal.id, "p1", {
        id: "p1",
        title: "Visible proposal",
        rank: 50,
        category: "visible",
        secret: "root-secret",
      }),
      object(Proposal.id, "p2", {
        id: "p2",
        title: "Hidden proposal",
        rank: 1,
        category: "hidden",
        secret: "hidden-secret",
      }),
      object(LineItem.id, "item-1", {
        id: "item-1",
        name: "Visible item",
        internal: "hidden",
      }),
      object(LineItem.id, "item-2", { id: "item-2", name: "Hidden item" }),
      object(LineItem.id, "review-1", { id: "review-1", name: "Visible reviewer" }),
      object(Product.id, "prod-1", {
        id: "prod-1",
        name: "Visible product",
        internal: "hidden",
      }),
      object(Product.id, "prod-review", {
        id: "prod-review",
        name: "Product outside nested path",
      }),
    ],
    links: [
      edge(Proposal.id, "p1", "items", LineItem.id, "item-1", {
        position: 1,
        internal: "hidden",
      }),
      edge(Proposal.id, "p2", "items", LineItem.id, "item-2", { position: 1 }),
      edge(Proposal.id, "p1", "reviewers", LineItem.id, "review-1"),
      edge(Proposal.id, "p1", "private", Product.id, "prod-review"),
      edge(LineItem.id, "item-1", "product", Product.id, "prod-1", {
        internal: "hidden edge property",
      }),
      edge(LineItem.id, "review-1", "product", Product.id, "prod-review"),
    ],
  })
})

afterAll(async () => {
  await storage.dropSchema()
  await storage.close()
})

describe("PgObjectStorage selected readers", () => {
  test("applies exact live object, edge, and property scope to direct reads", async () => {
    const reader = storage.objects.createReadScope({
      projectId,
      scope: proposalScope(),
      limits: defaultReadLimits,
    })

    expect(
      await reader.getByPrimaryId({ projectId, objectTypeId: Proposal.id, primaryId: "p1" })
    ).toMatchObject({ properties: { id: "p1", title: "Visible proposal" } })
    expect(
      await reader.getByPrimaryId({ projectId, objectTypeId: Proposal.id, primaryId: "p2" })
    ).toBeNull()
    expect(
      await reader.getByPrimaryId({ projectId, objectTypeId: Product.id, primaryId: "prod-1" })
    ).toMatchObject({ properties: { id: "prod-1", name: "Visible product" } })
    expect(
      await selectsObjectProperty(reader, {
        projectId,
        objectTypeId: Proposal.id,
        primaryId: "p1",
        propertyId: "title",
      })
    ).toBe(true)
    expect(
      await selectsObjectProperty(reader, {
        projectId,
        objectTypeId: Proposal.id,
        primaryId: "p1",
        propertyId: "optional",
      })
    ).toBe(true)
    expect(
      await selectsObjectProperty(reader, {
        projectId,
        objectTypeId: Proposal.id,
        primaryId: "p1",
        propertyId: "secret",
      })
    ).toBe(false)
    expect(
      await selectsObjectProperty(reader, {
        projectId,
        objectTypeId: Proposal.id,
        primaryId: "p2",
        propertyId: "title",
      })
    ).toBe(false)
    expect(
      await selectsObjectProperty(reader, {
        projectId,
        objectTypeId: Product.id,
        primaryId: "prod-1",
        propertyId: "name",
      })
    ).toBe(true)
    expect(
      await reader.selectsObjectProperties({
        projectId,
        items: [
          { objectTypeId: Proposal.id, primaryId: "p1", propertyId: "optional" },
          { objectTypeId: Product.id, primaryId: "prod-1", propertyId: "name" },
          { objectTypeId: Product.id, primaryId: "prod-1", propertyId: "name" },
          { objectTypeId: Product.id, primaryId: "prod-review", propertyId: "name" },
          { objectTypeId: Proposal.id, primaryId: "p1", propertyId: "secret" },
        ],
      })
    ).toEqual([true, true, true, false, false])

    const links = await reader.listLinks({
      projectId,
      objectTypeId: Proposal.id,
      objectId: "p1",
      linkId: "items",
    })
    expect(links).toHaveLength(1)
    expect(links[0]?.properties).toEqual({ position: 1 })
    expect(
      await reader.listLinks({
        projectId,
        objectTypeId: Proposal.id,
        objectId: "p1",
        linkId: "private",
      })
    ).toEqual([])
    expect(
      await reader.listLinks({
        projectId,
        objectTypeId: LineItem.id,
        objectId: "item-1",
        linkId: "items",
        direction: "incoming",
      })
    ).toHaveLength(1)
    const productLink = (
      await reader.listLinks({
        projectId,
        objectTypeId: LineItem.id,
        objectId: "item-1",
        linkId: "product",
      })
    )[0]
    expect(productLink?.properties).toBeUndefined()
    expect(productLink && Object.hasOwn(productLink, "properties")).toBe(false)

    const objectsById = await reader.getByPrimaryIdMany({
      projectId,
      items: [
        { objectTypeId: Proposal.id, primaryId: "p1" },
        { objectTypeId: Proposal.id, primaryId: "p2" },
        { objectTypeId: LineItem.id, primaryId: "item-1" },
      ],
    })
    expect(objectsById.map((row) => row?.primaryId ?? null)).toEqual(["p1", null, "item-1"])
    expect(objectsById[2]?.properties).toEqual({
      id: "item-1",
      name: "Visible item",
    })

    const linksByParent = await reader.listLinksMany({
      projectId,
      items: [
        { objectTypeId: Proposal.id, objectId: "p1", linkId: "items" },
        { objectTypeId: Proposal.id, objectId: "p1", linkId: "private" },
      ],
    })
    expect(linksByParent.map((links) => links.length)).toEqual([1, 0])

    const incomingLinks = await reader.listLinksMany({
      projectId,
      direction: "incoming",
      items: [
        { objectTypeId: LineItem.id, objectId: "item-1", linkId: "items" },
        { objectTypeId: LineItem.id, objectId: "item-1", linkId: "items" },
        { objectTypeId: Product.id, objectId: "prod-1", linkId: "product" },
        { objectTypeId: Product.id, objectId: "prod-review", linkId: "product" },
      ],
    })
    expect(incomingLinks[0]).toMatchObject([{ sourceId: "p1", targetId: "item-1" }])
    expect(incomingLinks[1]).toMatchObject([{ sourceId: "p1", targetId: "item-1" }])
    expect(incomingLinks[2]).toMatchObject([{ sourceId: "item-1", targetId: "prod-1" }])
    expect(incomingLinks[3]).toEqual([])

    const linksOnBothSides = await reader.listLinksMany({
      projectId,
      direction: "both",
      items: [
        { objectTypeId: LineItem.id, objectId: "item-1", linkId: "product" },
        { objectTypeId: Product.id, objectId: "prod-1", linkId: "product" },
      ],
    })
    expect(linksOnBothSides.map((links) => links.length)).toEqual([1, 1])

    expect(
      await reader.list({
        projectId,
        objectTypeId: Proposal.id,
        limit: 1,
        orderBy: "primaryId",
        order: "asc",
      })
    ).toMatchObject({ objects: [{ primaryId: "p1" }], total: 1, hasMore: false })
  })

  test("scopes before sorting, aggregation, traversal, and expansion", async () => {
    const reader = storage.objects.createReadScope({
      projectId,
      scope: proposalScope(),
      limits: defaultReadLimits,
    })
    const sorted = await reader.queryObjects?.({
      projectId,
      query: {
        kind: "limit",
        limit: 1,
        input: {
          kind: "sort",
          fields: [{ kind: "property", propertyId: "rank", direction: "asc" }],
          input: { kind: "start", objectTypeId: Proposal.id },
        },
      },
    })
    expect(sorted?.objects).toMatchObject([{ primaryId: "p1" }])
    expect(sorted?.total).toBe(1)

    const refs = await reader.queryObjects?.({
      projectId,
      query: {
        kind: "refs",
        refs: [
          { objectTypeId: Proposal.id, primaryId: "p2" },
          { objectTypeId: Proposal.id, primaryId: "p1" },
          { objectTypeId: Proposal.id, primaryId: "p1" },
        ],
      },
    })
    expect(refs?.objects).toHaveLength(1)
    expect(refs?.objects[0]).toMatchObject({
      primaryId: "p1",
      properties: {
        id: "p1",
        title: "Visible proposal",
        rank: 50,
        category: "visible",
      },
    })
    expect(refs?.objects[0]?.properties).not.toHaveProperty("secret")
    expect(refs?.total).toBe(1)

    expect(
      await reader.countObjects?.({
        projectId,
        query: { kind: "start", objectTypeId: Proposal.id },
      })
    ).toEqual({ count: 1 })
    expect(
      await reader.existsObjects?.({
        projectId,
        query: {
          kind: "filter",
          input: { kind: "start", objectTypeId: Proposal.id },
          predicate: { op: "eq", propertyId: "secret", value: "root-secret" },
        },
      })
    ).toEqual({ exists: false })
    expect(
      await reader.facetObjects?.({
        projectId,
        query: { kind: "start", objectTypeId: Proposal.id },
        facets: [
          { propertyId: "category", limit: 10 },
          { propertyId: "secret", limit: 10 },
        ],
      })
    ).toEqual({
      facets: [
        { propertyId: "category", buckets: [{ value: "visible", count: 1 }] },
        { propertyId: "secret", buckets: [] },
      ],
    })

    const nested = await reader.queryObjects?.({
      projectId,
      query: {
        kind: "traverse",
        direction: "outgoing",
        linkId: "product",
        input: { kind: "start", objectTypeId: LineItem.id },
      },
    })
    expect(nested?.objects).toMatchObject([{ primaryId: "prod-1" }])
    expect(
      await reader.getByPrimaryId({
        projectId,
        objectTypeId: Product.id,
        primaryId: "prod-review",
      })
    ).toBeNull()

    const expanded = await reader.queryObjects?.({
      projectId,
      query: {
        kind: "expand",
        input: { kind: "start", objectTypeId: Proposal.id },
        expansions: [{ linkId: "items", direction: "outgoing", cardinality: "many", limit: 10 }],
      },
    })
    expect(expanded?.objects[0]?.links?.items).toMatchObject([
      {
        primaryId: "item-1",
        properties: { id: "item-1", name: "Visible item" },
        linkProperties: { position: 1 },
      },
    ])
  })

  test("bounds live roots and path-sensitive edge occurrences at limit plus one", async () => {
    // p1 contributes one root plus items, item.product, and reviewers. The p2 graph, private link,
    // and reviewer.product edge are live but outside this selected path and therefore do not count.
    const exactReader = storage.objects.createReadScope({
      projectId,
      scope: proposalScope(),
      limits: { ...defaultReadLimits, maxTraversalFacts: 4 },
    })
    await expect(
      exactReader.getByPrimaryId({
        projectId,
        objectTypeId: Product.id,
        primaryId: "prod-1",
      })
    ).resolves.toMatchObject({ primaryId: "prod-1" })
    // Budgets apply independently to each operation; successful reads do not consume a session
    // counter.
    await expect(
      exactReader.getByPrimaryId({
        projectId,
        objectTypeId: Proposal.id,
        primaryId: "p1",
      })
    ).resolves.toMatchObject({ primaryId: "p1" })

    const overReader = storage.objects.createReadScope({
      projectId,
      scope: proposalScope(),
      limits: { ...defaultReadLimits, maxTraversalFacts: 3 },
    })
    await expect(
      overReader.getByPrimaryId({
        projectId,
        objectTypeId: Proposal.id,
        primaryId: "p1",
      })
    ).rejects.toMatchObject({
      name: "DelegatedExecutionLimitError",
      metric: "traversalFacts",
      limit: 3,
    })
    await expect(overReader.getByPrimaryIdMany({ projectId, items: [] })).rejects.toMatchObject({
      metric: "traversalFacts",
      limit: 3,
    })

    const duplicatePathScope = proposalItemsThroughTwoPathsScope()
    const duplicatePathExact = storage.objects.createReadScope({
      projectId,
      scope: duplicatePathScope,
      limits: { ...defaultReadLimits, maxTraversalFacts: 3 },
    })
    await expect(
      duplicatePathExact.getByPrimaryId({
        projectId,
        objectTypeId: LineItem.id,
        primaryId: "item-1",
      })
    ).resolves.toMatchObject({ primaryId: "item-1" })

    const duplicatePathOver = storage.objects.createReadScope({
      projectId,
      scope: duplicatePathScope,
      limits: { ...defaultReadLimits, maxTraversalFacts: 2 },
    })
    await expect(
      duplicatePathOver.getByPrimaryId({
        projectId,
        objectTypeId: LineItem.id,
        primaryId: "item-1",
      })
    ).rejects.toBeInstanceOf(DelegatedExecutionLimitError)

    const rootsScope = proposalRootsOnlyScope("p1", "p2", "missing")
    const rootsExact = storage.objects.createReadScope({
      projectId,
      scope: rootsScope,
      limits: { ...defaultReadLimits, maxTraversalFacts: 2 },
    })
    await expect(
      rootsExact.getByPrimaryId({
        projectId,
        objectTypeId: Proposal.id,
        primaryId: "p2",
      })
    ).resolves.toMatchObject({ primaryId: "p2" })

    const rootsOver = storage.objects.createReadScope({
      projectId,
      scope: rootsScope,
      limits: { ...defaultReadLimits, maxTraversalFacts: 1 },
    })
    await expect(
      rootsOver.getByPrimaryId({
        projectId,
        objectTypeId: Proposal.id,
        primaryId: "p1",
      })
    ).rejects.toMatchObject({ metric: "traversalFacts", limit: 1 })
  })

  test("rejects an oversized redacted terminal value without returning partial data", async () => {
    const baseline = storage.objects.createReadScope({
      projectId,
      scope: proposalScope(),
      limits: defaultReadLimits,
    })
    const visible = await baseline.getByPrimaryId({
      projectId,
      objectTypeId: Proposal.id,
      primaryId: "p1",
    })
    expect(visible).not.toBeNull()
    const visibleBytes = new TextEncoder().encode(JSON.stringify(visible)).byteLength

    const exactReader = storage.objects.createReadScope({
      projectId,
      scope: proposalScope(),
      limits: { ...defaultReadLimits, maxVisibleJsonBytes: visibleBytes },
    })
    await expect(
      exactReader.getByPrimaryId({
        projectId,
        objectTypeId: Proposal.id,
        primaryId: "p1",
      })
    ).resolves.toEqual(visible)

    const overReader = storage.objects.createReadScope({
      projectId,
      scope: proposalScope(),
      limits: { ...defaultReadLimits, maxVisibleJsonBytes: visibleBytes - 1 },
    })
    await expect(
      overReader.getByPrimaryId({
        projectId,
        objectTypeId: Proposal.id,
        primaryId: "p1",
      })
    ).rejects.toMatchObject({
      name: "DelegatedExecutionLimitError",
      metric: "visibleJsonBytes",
      limit: visibleBytes - 1,
    })
  })

  test("rejects more than sixteen facets before starting provider work", async () => {
    const reader = storage.objects.createReadScope({
      projectId,
      scope: proposalScope(),
      limits: { ...defaultReadLimits, maxTraversalFacts: 1 },
    })
    await expect(
      reader.facetObjects?.({
        projectId,
        query: { kind: "start", objectTypeId: Proposal.id },
        facets: Array.from({ length: 17 }, (_, index) => ({
          propertyId: `facet-${index}`,
          limit: 1,
        })),
      })
    ).rejects.toThrow("at most 16 facets")
  })

  test("rejects cross-project reader reuse", async () => {
    const readerInput = { projectId, scope: proposalScope(), limits: defaultReadLimits }
    const reader = storage.objects.createReadScope(readerInput)
    readerInput.projectId = "another-project"
    await expect(
      reader.getByPrimaryId({
        projectId: "another-project",
        objectTypeId: Proposal.id,
        primaryId: "p1",
      })
    ).rejects.toThrow("belongs to project 'pg-read-scope'")
    await expect(
      selectsObjectProperty(reader, {
        projectId: "another-project",
        objectTypeId: Proposal.id,
        primaryId: "p1",
        propertyId: "title",
      })
    ).rejects.toThrow("belongs to project 'pg-read-scope'")
    expect((await reader.list({ projectId })).total).toBeGreaterThan(0)
  })

  test("unrestricted property selection requires only the exact object", async () => {
    const reader = storage.objects.createReadScope({
      projectId,
      scope: { kind: "all" },
      limits: defaultReadLimits,
    })
    expect(
      await selectsObjectProperty(reader, {
        projectId,
        objectTypeId: Proposal.id,
        primaryId: "p1",
        propertyId: "not-materialized",
      })
    ).toBe(true)
    expect(
      await selectsObjectProperty(reader, {
        projectId,
        objectTypeId: Proposal.id,
        primaryId: "missing",
        propertyId: "title",
      })
    ).toBe(false)
  })

  test("executes a batch larger than the PostgreSQL bind-parameter limit as one set", async () => {
    // Three columns per row made the previous VALUES join require 66,000 bind parameters.
    const items = Array.from({ length: 22_000 }, (_, index) => ({
      objectTypeId: Proposal.id,
      objectId: index === 0 ? "p1" : `missing-${index}`,
      linkId: "items",
    }))

    const linksByParent = await storage.objects.listLinksBatch({ projectId, items })

    expect(linksByParent.size).toBe(1)
    expect(linksByParent.get(`${Proposal.id}:p1:items`)).toMatchObject([
      { sourceId: "p1", linkId: "items", targetId: "item-1" },
    ])
  })

  test("resolves object and link instances live after reader creation", async () => {
    const reader = storage.objects.createReadScope({
      projectId,
      scope: proposalScope("p-live"),
      limits: defaultReadLimits,
    })
    expect(
      await reader.getByPrimaryId({
        projectId,
        objectTypeId: Proposal.id,
        primaryId: "p-live",
      })
    ).toBeNull()

    await fixture.seed({
      objects: [
        object(Proposal.id, "p-live", {
          id: "p-live",
          title: "Added after reader creation",
          rank: 100,
          category: "live",
          secret: "hidden",
        }),
        object(LineItem.id, "item-live", { id: "item-live", name: "Live item" }),
      ],
      links: [edge(Proposal.id, "p-live", "items", LineItem.id, "item-live", { position: 2 })],
    })

    expect(
      await reader.getByPrimaryId({
        projectId,
        objectTypeId: LineItem.id,
        primaryId: "item-live",
      })
    ).toMatchObject({ properties: { id: "item-live", name: "Live item" } })
  })

  test("keeps the traversal probe and terminal query on one repeatable snapshot", async () => {
    // Regression guard: use READ COMMITTED, or remove the scoped transaction, and the item inserted
    // after the traversal probe appears in the terminal result from the same reader operation.
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) throw new Error("DATABASE_URL is required")
    const readerPool = createPgClient({ connectionString, schemaName, max: 1 })
    const writerPool = createPgClient({ connectionString, schemaName, max: 1 })
    const snapshotItemId = "item-repeatable-snapshot"
    let inserted = false
    let beginMode: unknown

    const insertAfterProbe = async (): Promise<void> => {
      if (inserted) return
      inserted = true
      await writerPool.begin(async (writer) => {
        const timestamp = "2026-08-28T00:00:00.000Z"
        await writer.unsafe(
          `INSERT INTO objects (
             project_id, object_type_id, primary_id, properties,
             created_at, updated_at, version, last_commit_id
           ) VALUES ($1, $2, $3, $4::text::jsonb, $5, $5, 1, $6)`,
          [
            projectId,
            LineItem.id,
            snapshotItemId,
            JSON.stringify({ id: snapshotItemId, name: "Added after probe" }),
            timestamp,
            "snapshot-object",
          ]
        )
        await writer.unsafe(
          `INSERT INTO links (
             project_id, source_type_id, source_id, link_id, target_type_id, target_id,
             properties, created_at, updated_at, last_commit_id
           ) VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $7, $8)`,
          [
            projectId,
            Proposal.id,
            "p1",
            "items",
            LineItem.id,
            snapshotItemId,
            timestamp,
            "snapshot-link",
          ]
        )
      })
    }

    const wrapTransactionClient = (tx: SQLClient): SQLClient =>
      ({
        unsafe: async (sql: string, params: readonly unknown[] = []) => {
          const result = await tx.unsafe(sql, params as SqlParameter[])
          await insertAfterProbe()
          return result
        },
      }) as unknown as SQLClient
    const instrumentedPool = {
      unsafe: async (sql: string, params: readonly unknown[] = []) => {
        const result = await readerPool.unsafe(sql, params as SqlParameter[])
        await insertAfterProbe()
        return result
      },
      begin: (mode: unknown, run: (tx: SQLClient) => Promise<unknown>) => {
        beginMode = mode
        return readerPool.begin(mode as string, (tx) => run(wrapTransactionClient(tx)))
      },
    } as unknown as PgStoreClient

    try {
      const reader = new PgObjectStorage(instrumentedPool).createReadScope({
        projectId,
        scope: proposalItemsScope(),
        limits: defaultReadLimits,
      })
      const result = await reader.queryObjects?.({
        projectId,
        query: { kind: "start", objectTypeId: LineItem.id },
      })

      expect(beginMode).toBe("isolation level repeatable read")
      expect(result?.total).toBe(1)
      expect(result?.objects.map((row) => row.primaryId)).toEqual(["item-1"])
    } finally {
      await writerPool.unsafe(
        "DELETE FROM links WHERE project_id = $1 AND target_type_id = $2 AND target_id = $3",
        [projectId, LineItem.id, snapshotItemId]
      )
      await writerPool.unsafe(
        "DELETE FROM objects WHERE project_id = $1 AND object_type_id = $2 AND primary_id = $3",
        [projectId, LineItem.id, snapshotItemId]
      )
      await readerPool.end({ timeout: 1 })
      await writerPool.end({ timeout: 1 })
    }
  })
})

function proposalItemsScope(): ObjectReadScope {
  return {
    kind: "selected",
    roots: [
      {
        anchor: { objectTypeId: Proposal.id, primaryId: "p1" },
        node: {
          objects: [{ objectTypeId: Proposal.id, propertyIds: ["id"] }],
          links: [
            {
              definitions: [
                {
                  sourceObjectTypeId: Proposal.id,
                  linkId: "items",
                  targetObjectTypeIds: [LineItem.id],
                  propertyIds: [],
                },
              ],
              target: {
                objects: [{ objectTypeId: LineItem.id, propertyIds: ["id", "name"] }],
                links: [],
              },
            },
          ],
        },
      },
    ],
  }
}

function proposalScope(primaryId = "p1"): ObjectReadScope {
  return {
    kind: "selected",
    roots: [
      {
        anchor: { objectTypeId: Proposal.id, primaryId },
        node: {
          objects: [
            {
              objectTypeId: Proposal.id,
              propertyIds: ["id", "title", "rank", "category", "optional"],
            },
          ],
          links: [
            {
              definitions: [
                {
                  sourceObjectTypeId: Proposal.id,
                  linkId: "items",
                  targetObjectTypeIds: [LineItem.id],
                  propertyIds: ["position"],
                },
              ],
              target: {
                objects: [{ objectTypeId: LineItem.id, propertyIds: ["id", "name"] }],
                links: [
                  {
                    definitions: [
                      {
                        sourceObjectTypeId: LineItem.id,
                        linkId: "product",
                        targetObjectTypeIds: [Product.id],
                        propertyIds: [],
                      },
                    ],
                    target: {
                      objects: [{ objectTypeId: Product.id, propertyIds: ["id", "name"] }],
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
                  linkId: "reviewers",
                  targetObjectTypeIds: [LineItem.id],
                  propertyIds: [],
                },
              ],
              target: {
                objects: [{ objectTypeId: LineItem.id, propertyIds: ["id", "name"] }],
                links: [],
              },
            },
          ],
        },
      },
    ],
  }
}

function proposalItemsThroughTwoPathsScope(): ObjectReadScope {
  const itemPath = () => ({
    definitions: [
      {
        sourceObjectTypeId: Proposal.id,
        linkId: "items",
        targetObjectTypeIds: [LineItem.id],
        propertyIds: ["position"],
      },
    ],
    target: {
      objects: [{ objectTypeId: LineItem.id, propertyIds: ["id", "name"] }],
      links: [],
    },
  })

  return {
    kind: "selected",
    roots: [
      {
        anchor: { objectTypeId: Proposal.id, primaryId: "p1" },
        node: {
          objects: [{ objectTypeId: Proposal.id, propertyIds: ["id", "title"] }],
          links: [itemPath(), itemPath()],
        },
      },
    ],
  }
}

function proposalRootsOnlyScope(...primaryIds: readonly string[]): ObjectReadScope {
  return {
    kind: "selected",
    roots: primaryIds.map((primaryId) => ({
      anchor: { objectTypeId: Proposal.id, primaryId },
      node: {
        objects: [{ objectTypeId: Proposal.id, propertyIds: ["id", "title"] }],
        links: [],
      },
    })),
  }
}

function object(
  objectTypeId: string,
  primaryId: string,
  properties: Record<string, string | number>
) {
  return { ref: { objectTypeId, primaryId }, properties }
}

function edge(
  sourceObjectTypeId: string,
  sourceId: string,
  linkId: string,
  targetObjectTypeId: string,
  targetId: string,
  properties?: Record<string, string | number>
) {
  return {
    ref: {
      source: { objectTypeId: sourceObjectTypeId, primaryId: sourceId },
      linkId,
      target: { objectTypeId: targetObjectTypeId, primaryId: targetId },
    },
    ...(properties ? { properties } : {}),
  }
}
