import { describe, expect, test } from "bun:test"
import { DEFAULT_DELEGATED_EXECUTION_LIMITS } from "../src/execution/limits"
import type { JsonValue } from "../src/json"
import type { ObjectQuery } from "../src/objects/query"
import {
  getInMemoryObjectMaterializerAdapter,
  InMemoryObjectStorage,
} from "../src/storage/objects/in-memory"
import type { ObjectReadScope } from "../src/storage/objects/types"

const projectId = "scope-project"
const createdAt = "2026-01-01T00:00:00.000Z"
const limits = DEFAULT_DELEGATED_EXECUTION_LIMITS

describe("InMemoryObjectStorage scoped readers", () => {
  test("resolves a live exact graph, redacts properties, and returns detached rows", async () => {
    const storage = seededStorage()
    const reader = storage.createReadScope({ projectId, scope: proposalScope(), limits })

    expect(
      await reader.getByPrimaryId({ projectId, objectTypeId: "Proposal", primaryId: "p1" })
    ).toMatchObject({
      primaryId: "p1",
      properties: { id: "p1", title: "Visible proposal" },
    })
    expect(
      await reader.getByPrimaryId({ projectId, objectTypeId: "Proposal", primaryId: "p2" })
    ).toBeNull()
    expect(
      await reader.getByPrimaryId({ projectId, objectTypeId: "Product", primaryId: "prod-1" })
    ).toMatchObject({ properties: { id: "prod-1", name: "Visible product" } })
    expect(
      await reader.selectsObjectProperties({
        projectId,
        items: [
          { objectTypeId: "LineItem", primaryId: "item-1", propertyId: "price" },
          { objectTypeId: "LineItem", primaryId: "review-1", propertyId: "price" },
          { objectTypeId: "LineItem", primaryId: "item-1", propertyId: "price" },
          { objectTypeId: "LineItem", primaryId: "item-1", propertyId: "price" },
          { objectTypeId: "LineItem", primaryId: "review-1", propertyId: "price" },
          { objectTypeId: "LineItem", primaryId: "item-2", propertyId: "price" },
        ],
      })
    ).toEqual([true, false, true, true, false, false])

    const listed = await reader.list({
      projectId,
      objectTypeId: "Proposal",
      orderBy: "primaryId",
      order: "asc",
    })
    expect(listed).toMatchObject({ total: 1, hasMore: false })
    expect(listed.objects).toMatchObject([{ primaryId: "p1" }])

    const objectBatch = await reader.getByPrimaryIdMany({
      projectId,
      items: [
        { objectTypeId: "Proposal", primaryId: "p1" },
        { objectTypeId: "Proposal", primaryId: "p2" },
        { objectTypeId: "LineItem", primaryId: "item-1" },
      ],
    })
    expect(objectBatch.map((row) => row?.primaryId ?? null)).toEqual(["p1", null, "item-1"])
    expect(objectBatch[2]?.properties).toEqual({
      id: "item-1",
      name: "Visible item",
    })

    const itemLinks = await reader.listLinks({
      projectId,
      objectTypeId: "Proposal",
      objectId: "p1",
      linkId: "items",
    })
    expect(itemLinks).toHaveLength(1)
    expect(itemLinks[0]?.properties).toEqual({ position: 1 })
    const linkBatch = await reader.listLinksMany({
      projectId,
      items: [
        { objectTypeId: "Proposal", objectId: "p1", linkId: "items" },
        { objectTypeId: "Proposal", objectId: "p2", linkId: "items" },
      ],
    })
    expect(linkBatch.map((links) => links.length)).toEqual([1, 0])
    expect(linkBatch[0]?.[0]?.properties).toEqual({ position: 1 })
    const incomingBatch = await reader.listLinksMany({
      projectId,
      direction: "incoming",
      items: [
        { objectTypeId: "LineItem", objectId: "item-1", linkId: "items" },
        { objectTypeId: "LineItem", objectId: "item-1", linkId: "items" },
        { objectTypeId: "LineItem", objectId: "item-2", linkId: "items" },
      ],
    })
    expect(incomingBatch.map((links) => links.length)).toEqual([1, 1, 0])
    expect(incomingBatch[0]?.[0]).toMatchObject({
      sourceTypeId: "Proposal",
      sourceId: "p1",
      properties: { position: 1 },
    })
    expect(
      await reader.listLinks({
        projectId,
        objectTypeId: "Proposal",
        objectId: "p1",
        linkId: "private",
      })
    ).toEqual([])
    expect(
      await reader.listLinks({
        projectId,
        objectTypeId: "LineItem",
        objectId: "item-1",
        linkId: "items",
        direction: "incoming",
      })
    ).toHaveLength(1)

    const first = await reader.getByPrimaryId({
      projectId,
      objectTypeId: "LineItem",
      primaryId: "item-1",
    })
    if (!first) throw new Error("expected selected item")
    first.properties.name = "mutated outside storage"
    expect(
      await reader.getByPrimaryId({
        projectId,
        objectTypeId: "LineItem",
        primaryId: "item-1",
      })
    ).toMatchObject({ properties: { name: "Visible item" } })

    const adapter = getInMemoryObjectMaterializerAdapter(storage)
    applyObject(adapter, "LineItem", "item-live", {
      id: "item-live",
      name: "Added after reader creation",
      internal: "hidden",
    })
    applyLink(adapter, "Proposal", "p1", "items", "LineItem", "item-live", {
      position: 2,
      internal: "hidden",
    })

    expect(
      await reader.getByPrimaryId({
        projectId,
        objectTypeId: "LineItem",
        primaryId: "item-live",
      })
    ).toMatchObject({
      properties: { id: "item-live", name: "Added after reader creation" },
    })

    adapter.deleteExactLink({
      projectId,
      sourceTypeId: "Proposal",
      sourceId: "p1",
      linkId: "items",
      targetTypeId: "LineItem",
      targetId: "item-1",
    })
    expect(
      await reader.getByPrimaryId({
        projectId,
        objectTypeId: "LineItem",
        primaryId: "item-1",
      })
    ).toBeNull()
  })

  test("applies identity and property scope before sort, vector top-k, count, exists, and facets", async () => {
    const storage = seededStorage()
    const reader = storage.createReadScope({ projectId, scope: proposalScope(), limits })

    const sorted: ObjectQuery = {
      kind: "limit",
      limit: 1,
      input: {
        kind: "sort",
        fields: [{ kind: "property", propertyId: "rank", direction: "asc" }],
        input: { kind: "start", objectTypeId: "Proposal" },
      },
    }
    expect((await reader.queryObjects?.({ projectId, query: sorted }))?.objects).toMatchObject([
      { primaryId: "p1" },
    ])

    const vector: ObjectQuery = {
      kind: "vector",
      input: { kind: "start", objectTypeId: "Proposal" },
      propertyId: "embedding",
      vector: [1, 0],
      k: 1,
    }
    expect((await reader.queryObjects?.({ projectId, query: vector }))?.objects).toMatchObject([
      { primaryId: "p1" },
    ])
    expect(
      await reader.countObjects?.({
        projectId,
        query: { kind: "start", objectTypeId: "Proposal" },
      })
    ).toEqual({ count: 1 })
    expect(
      await reader.existsObjects?.({
        projectId,
        query: {
          kind: "filter",
          input: { kind: "start", objectTypeId: "Proposal" },
          predicate: { op: "eq", propertyId: "secret", value: "root-secret" },
        },
      })
    ).toEqual({ exists: false })
    expect(
      await reader.facetObjects?.({
        projectId,
        query: { kind: "start", objectTypeId: "Proposal" },
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
  })

  test("applies identity and property scope to exact refs", async () => {
    const storage = seededStorage()
    const reader = storage.createReadScope({ projectId, scope: proposalScope(), limits })
    const refs: ObjectQuery = {
      kind: "refs",
      refs: [
        { objectTypeId: "Proposal", primaryId: "p2" },
        { objectTypeId: "LineItem", primaryId: "item-2" },
        { objectTypeId: "Proposal", primaryId: "p1" },
        { objectTypeId: "LineItem", primaryId: "item-1" },
      ],
    }

    const result = await reader.queryObjects?.({ projectId, query: refs })
    expect(result?.objects.map((row) => `${row.objectTypeId}:${row.primaryId}`)).toEqual([
      "LineItem:item-1",
      "Proposal:p1",
    ])
    expect(result?.objects.map((row) => row.properties)).toEqual([
      { id: "item-1", name: "Visible item" },
      {
        id: "p1",
        title: "Visible proposal",
        category: "visible",
        embedding: [0, 1],
        rank: 50,
      },
    ])
    expect(await reader.countObjects?.({ projectId, query: refs })).toEqual({ count: 2 })
    expect(
      await reader.existsObjects?.({
        projectId,
        query: {
          kind: "refs",
          refs: [{ objectTypeId: "Proposal", primaryId: "p2" }],
        },
      })
    ).toEqual({ exists: false })
  })

  test("traverses only selected edge instances and preserves nested path provenance", async () => {
    const storage = seededStorage()
    const reader = storage.createReadScope({ projectId, scope: proposalScope(), limits })

    const outgoing: ObjectQuery = {
      kind: "traverse",
      direction: "outgoing",
      linkId: "items",
      input: { kind: "start", objectTypeId: "Proposal" },
    }
    expect((await reader.queryObjects?.({ projectId, query: outgoing }))?.objects).toMatchObject([
      { primaryId: "item-1" },
    ])

    const incoming: ObjectQuery = {
      kind: "traverse",
      direction: "incoming",
      sourceObjectTypeId: "Proposal",
      linkId: "items",
      input: { kind: "start", objectTypeId: "LineItem" },
    }
    expect((await reader.queryObjects?.({ projectId, query: incoming }))?.objects).toMatchObject([
      { primaryId: "p1" },
    ])

    // Both line items are visible, but only the one reached through `items` received nested
    // `product` authority. The same physical type reached through `reviewers` cannot borrow it.
    const nested: ObjectQuery = {
      kind: "traverse",
      direction: "outgoing",
      linkId: "product",
      input: { kind: "start", objectTypeId: "LineItem" },
    }
    expect((await reader.queryObjects?.({ projectId, query: nested }))?.objects).toMatchObject([
      { primaryId: "prod-1" },
    ])
    expect(
      await reader.getByPrimaryId({
        projectId,
        objectTypeId: "Product",
        primaryId: "prod-review",
      })
    ).toBeNull()
  })

  test("enforces independent traversal and visible JSON budgets before returning data", async () => {
    const storage = seededStorage()
    const atLimit = storage.createReadScope({
      projectId,
      scope: proposalScope(),
      limits: { ...limits, maxTraversalFacts: 4 },
    })
    expect(
      await atLimit.getByPrimaryId({
        projectId,
        objectTypeId: "Proposal",
        primaryId: "p1",
      })
    ).toMatchObject({ primaryId: "p1" })

    const overLimit = storage.createReadScope({
      projectId,
      scope: proposalScope(),
      limits: { ...limits, maxTraversalFacts: 3 },
    })
    await expect(
      overLimit.getByPrimaryId({
        projectId,
        objectTypeId: "Proposal",
        primaryId: "p1",
      })
    ).rejects.toMatchObject({
      code: "delegated_execution_limit_exceeded",
      metric: "traversalFacts",
      limit: 3,
    })

    // Each operation receives a fresh budget; a prior failure cannot poison the reader.
    await expect(overLimit.list({ projectId, objectTypeId: "Proposal" })).rejects.toMatchObject({
      metric: "traversalFacts",
    })

    const tinyOutput = storage.createReadScope({
      projectId,
      scope: proposalScope(),
      limits: { ...limits, maxVisibleJsonBytes: 8 },
    })
    await expect(
      tinyOutput.getByPrimaryId({
        projectId,
        objectTypeId: "Proposal",
        primaryId: "p1",
      })
    ).rejects.toMatchObject({
      code: "delegated_execution_limit_exceeded",
      metric: "visibleJsonBytes",
      limit: 8,
    })
  })

  test("counts the same live edge once per selected path step", async () => {
    const storage = seededStorage()
    const repeatedPathScope: ObjectReadScope = {
      kind: "selected",
      roots: [
        {
          anchor: { objectTypeId: "Proposal", primaryId: "p1" },
          node: {
            objects: [{ objectTypeId: "Proposal", propertyIds: ["id"] }],
            links: [selectedItemsNode(), selectedItemsNode()],
          },
        },
      ],
    }
    const reader = storage.createReadScope({
      projectId,
      scope: repeatedPathScope,
      limits: { ...limits, maxTraversalFacts: 2 },
    })
    await expect(reader.list({ projectId })).rejects.toMatchObject({
      metric: "traversalFacts",
      limit: 2,
    })
  })

  test("binds readers to one project and clones unrestricted results", async () => {
    const storage = seededStorage()
    const readerInput = { projectId, scope: { kind: "all" } as const }
    const reader = storage.createReadScope({ ...readerInput, limits })
    readerInput.projectId = "another-project"

    await expect(
      reader.getByPrimaryId({
        projectId: "another-project",
        objectTypeId: "Proposal",
        primaryId: "p1",
      })
    ).rejects.toThrow("belongs to project 'scope-project'")

    expect((await reader.list({ projectId })).total).toBeGreaterThan(0)

    const row = await reader.getByPrimaryId({
      projectId,
      objectTypeId: "Proposal",
      primaryId: "p1",
    })
    if (!row) throw new Error("expected unrestricted row")
    row.properties.title = "mutated"
    expect(
      await reader.getByPrimaryId({ projectId, objectTypeId: "Proposal", primaryId: "p1" })
    ).toMatchObject({ properties: { title: "Visible proposal" } })
  })

  test("preserves prototype-like property ids as plain own properties", async () => {
    const storage = new InMemoryObjectStorage()
    const adapter = getInMemoryObjectMaterializerAdapter(storage)
    applyObject(
      adapter,
      "PrototypeCase",
      "prototype-1",
      Object.fromEntries([
        ["id", "prototype-1"],
        ["__proto__", "visible"],
      ])
    )
    const reader = storage.createReadScope({
      projectId,
      limits,
      scope: {
        kind: "selected",
        roots: [
          {
            anchor: { objectTypeId: "PrototypeCase", primaryId: "prototype-1" },
            node: {
              objects: [{ objectTypeId: "PrototypeCase", propertyIds: ["id", "__proto__"] }],
              links: [],
            },
          },
        ],
      },
    })

    const row = await reader.getByPrimaryId({
      projectId,
      objectTypeId: "PrototypeCase",
      primaryId: "prototype-1",
    })
    expect(row?.properties.__proto__).toBe("visible")
    expect(Object.hasOwn(row?.properties ?? {}, "__proto__")).toBe(true)
    expect(Object.getPrototypeOf(row?.properties ?? null)).toBe(Object.prototype)
  })
})

function seededStorage(): InMemoryObjectStorage {
  const storage = new InMemoryObjectStorage()
  const adapter = getInMemoryObjectMaterializerAdapter(storage)

  applyObject(adapter, "Proposal", "p1", {
    id: "p1",
    title: "Visible proposal",
    rank: 50,
    category: "visible",
    embedding: [0, 1],
    secret: "root-secret",
  })
  applyObject(adapter, "Proposal", "p2", {
    id: "p2",
    title: "Hidden proposal",
    rank: 1,
    category: "hidden",
    embedding: [1, 0],
    secret: "hidden-secret",
  })
  applyObject(adapter, "LineItem", "item-1", {
    id: "item-1",
    name: "Visible item",
    internal: "hidden",
  })
  applyObject(adapter, "LineItem", "item-2", { id: "item-2", name: "Hidden item" })
  applyObject(adapter, "LineItem", "review-1", { id: "review-1", name: "Visible reviewer" })
  applyObject(adapter, "Product", "prod-1", {
    id: "prod-1",
    name: "Visible product",
    internal: "hidden",
  })
  applyObject(adapter, "Product", "prod-review", {
    id: "prod-review",
    name: "Product outside nested path",
  })

  applyLink(adapter, "Proposal", "p1", "items", "LineItem", "item-1", {
    position: 1,
    internal: "hidden",
  })
  applyLink(adapter, "Proposal", "p2", "items", "LineItem", "item-2", { position: 1 })
  applyLink(adapter, "Proposal", "p1", "reviewers", "LineItem", "review-1")
  applyLink(adapter, "Proposal", "p1", "private", "Product", "prod-review")
  applyLink(adapter, "LineItem", "item-1", "product", "Product", "prod-1")
  applyLink(adapter, "LineItem", "review-1", "product", "Product", "prod-review")
  return storage
}

function proposalScope(): ObjectReadScope {
  return {
    kind: "selected",
    roots: [
      {
        anchor: { objectTypeId: "Proposal", primaryId: "p1" },
        node: {
          objects: [
            {
              objectTypeId: "Proposal",
              propertyIds: ["id", "title", "rank", "category", "embedding"],
            },
          ],
          links: [
            {
              definitions: [
                {
                  sourceObjectTypeId: "Proposal",
                  linkId: "items",
                  targetObjectTypeIds: ["LineItem"],
                  propertyIds: ["position"],
                },
              ],
              target: {
                objects: [{ objectTypeId: "LineItem", propertyIds: ["id", "name", "price"] }],
                links: [
                  {
                    definitions: [
                      {
                        sourceObjectTypeId: "LineItem",
                        linkId: "product",
                        targetObjectTypeIds: ["Product"],
                        propertyIds: [],
                      },
                    ],
                    target: {
                      objects: [{ objectTypeId: "Product", propertyIds: ["id", "name"] }],
                      links: [],
                    },
                  },
                ],
              },
            },
            {
              definitions: [
                {
                  sourceObjectTypeId: "Proposal",
                  linkId: "reviewers",
                  targetObjectTypeIds: ["LineItem"],
                  propertyIds: [],
                },
              ],
              target: {
                objects: [{ objectTypeId: "LineItem", propertyIds: ["id", "name"] }],
                links: [],
              },
            },
          ],
        },
      },
    ],
  }
}

function selectedItemsNode(): Extract<
  Extract<ObjectReadScope, { readonly kind: "selected" }>["roots"][number]["node"]["links"][number],
  object
> {
  return {
    definitions: [
      {
        sourceObjectTypeId: "Proposal",
        linkId: "items",
        targetObjectTypeIds: ["LineItem"],
        propertyIds: [],
      },
    ],
    target: {
      objects: [{ objectTypeId: "LineItem", propertyIds: ["id"] }],
      links: [],
    },
  }
}

type MaterializerAdapter = ReturnType<typeof getInMemoryObjectMaterializerAdapter>

function applyObject(
  adapter: MaterializerAdapter,
  objectTypeId: string,
  primaryId: string,
  properties: Record<string, JsonValue>
): void {
  adapter.applyExactObject(
    {
      ref: { objectTypeId, primaryId },
      properties,
      version: 1,
      createdAt,
      updatedAt: createdAt,
      lastCommitId: `commit:${objectTypeId}:${primaryId}`,
    },
    projectId
  )
}

function applyLink(
  adapter: MaterializerAdapter,
  sourceObjectTypeId: string,
  sourcePrimaryId: string,
  linkId: string,
  targetObjectTypeId: string,
  targetPrimaryId: string,
  properties?: Record<string, JsonValue>
): void {
  adapter.applyExactLink(
    {
      ref: {
        source: { objectTypeId: sourceObjectTypeId, primaryId: sourcePrimaryId },
        linkId,
        target: { objectTypeId: targetObjectTypeId, primaryId: targetPrimaryId },
      },
      properties,
      createdAt,
      updatedAt: createdAt,
      lastCommitId: `commit:${sourceObjectTypeId}:${sourcePrimaryId}:${linkId}:${targetPrimaryId}`,
    },
    projectId
  )
}
