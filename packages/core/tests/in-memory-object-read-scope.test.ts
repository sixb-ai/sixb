import { describe, expect, test } from "bun:test"
import type { JsonValue } from "../src/json"
import { compileSelectedObjectReadScope, linkBatchKey } from "../src/storage"
import { InMemoryStorage } from "../src/storage/in-memory"
import {
  getInMemoryObjectMaterializerAdapter,
  InMemoryObjectStorage,
} from "../src/storage/objects/in-memory"
import type { ObjectReadScopeFactory, ObjectStorage } from "../src/storage/objects/types"
import {
  createMaterializerTestFixture,
  objectReadScopeContractOntology,
  runObjectReadScopeContractSuite,
} from "../src/testing"

runObjectReadScopeContractSuite("InMemoryStorage selected object-read scope contract", {
  createHarness: () => {
    const storage = new InMemoryStorage()
    return { storage, objectReadScopeFactory: requireScopeFactory(storage.objects) }
  },
})

describe("InMemoryObjectStorage selected read behavior", () => {
  test("keeps batch link keys in first-request order for incoming and both directions", async () => {
    const projectId = "in-memory-link-batch-order"
    const storage = new InMemoryObjectStorage()
    const adapter = getInMemoryObjectMaterializerAdapter(storage)
    const timestamp = "2026-01-01T00:00:00.000Z"

    for (const [sourceId, targetId] of [
      ["source-a", "target-a"],
      ["source-b", "target-b"],
    ] as const) {
      adapter.applyExactLink(
        {
          ref: {
            source: { objectTypeId: "Source", primaryId: sourceId },
            linkId: "items",
            target: { objectTypeId: "Target", primaryId: targetId },
          },
          createdAt: timestamp,
          updatedAt: timestamp,
          lastCommitId: `commit:${sourceId}`,
        },
        projectId
      )
    }

    const items = [
      { objectTypeId: "Target", objectId: "target-b", linkId: "items" },
      { objectTypeId: "Target", objectId: "target-b", linkId: "items" },
      { objectTypeId: "Target", objectId: "target-a", linkId: "items" },
    ] as const
    const expectedKeys = [
      linkBatchKey("Target", "target-b", "items"),
      linkBatchKey("Target", "target-a", "items"),
    ]

    for (const direction of ["incoming", "both"] as const) {
      const result = await storage.listLinksBatch({ projectId, direction, items })
      expect([...result.keys()]).toEqual(expectedKeys)
    }
  })

  test("constrains identity and properties before vector top-k", async () => {
    const storage = new InMemoryStorage()
    const fixture = createMaterializerTestFixture({
      projectId: "in-memory-vector-scope",
      ontology: objectReadScopeContractOntology,
      storage,
    })
    await fixture.seed({
      objects: [
        {
          ref: { objectTypeId: "ScopeProposal", primaryId: "visible" },
          properties: { id: "visible", title: "Visible", embedding: [0, 1] },
        },
        {
          ref: { objectTypeId: "ScopeProposal", primaryId: "hidden" },
          properties: { id: "hidden", title: "Hidden", embedding: [1, 0] },
        },
      ],
    })

    const reader = requireScopeFactory(storage.objects).createSelectedReadScope({
      projectId: "in-memory-vector-scope",
      scope: compileSelectedObjectReadScope({
        kind: "selected",
        roots: [
          {
            anchor: { objectTypeId: "ScopeProposal", primaryId: "visible" },
            node: {
              objects: [{ objectTypeId: "ScopeProposal", propertyIds: ["id", "embedding"] }],
              links: [],
            },
          },
        ],
      }),
      limits: { maxTraversalFacts: 10, maxOutputJsonBytes: 10_000 },
    })
    const result = await reader.queryObjects?.({
      projectId: "in-memory-vector-scope",
      query: {
        kind: "vector",
        input: { kind: "start", objectTypeId: "ScopeProposal" },
        propertyId: "embedding",
        vector: [1, 0],
        k: 1,
      },
    })

    expect(result?.objects.map((row) => row.primaryId)).toEqual(["visible"])
  })

  test("strips pre-attached links, preserves prototype-like ids, and returns detached clones", async () => {
    const projectId = "in-memory-redaction-scope"
    const storage = new InMemoryObjectStorage()
    const adapter = getInMemoryObjectMaterializerAdapter(storage)
    adapter.applyExactObject(
      {
        ref: { objectTypeId: "PrototypeCase", primaryId: "prototype-1" },
        properties: Object.fromEntries([
          ["id", "prototype-1"],
          ["__proto__", "visible"],
          ["secret", "hidden"],
        ]) as Record<string, JsonValue>,
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        lastCommitId: "commit:prototype-1",
      },
      projectId
    )
    const raw = await storage.getByPrimaryId({
      projectId,
      objectTypeId: "PrototypeCase",
      primaryId: "prototype-1",
    })
    if (!raw) throw new Error("expected raw row")
    raw.links = {
      hidden: {
        ...raw,
        primaryId: "hidden",
        linkProperties: { secret: "hidden" },
      },
    }

    const reader = storage.createSelectedReadScope({
      projectId,
      scope: compileSelectedObjectReadScope({
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
      }),
      limits: { maxTraversalFacts: 10, maxOutputJsonBytes: 10_000 },
    })
    const first = await reader.getByPrimaryId({
      projectId,
      objectTypeId: "PrototypeCase",
      primaryId: "prototype-1",
    })

    expect(first?.links).toBeUndefined()
    expect(first?.properties).toEqual(
      Object.fromEntries([
        ["__proto__", "visible"],
        ["id", "prototype-1"],
      ])
    )
    expect(Object.hasOwn(first?.properties ?? {}, "__proto__")).toBe(true)
    expect(Object.getPrototypeOf(first?.properties ?? null)).toBe(Object.prototype)

    if (!first) throw new Error("expected selected row")
    first.properties.id = "mutated"
    expect(
      await reader.getByPrimaryId({
        projectId,
        objectTypeId: "PrototypeCase",
        primaryId: "prototype-1",
      })
    ).toMatchObject({ properties: { id: "prototype-1" } })
  })
})

function requireScopeFactory(storage: ObjectStorage): ObjectReadScopeFactory {
  if (!("createSelectedReadScope" in storage)) {
    throw new Error("[Sixb] Expected the in-memory object-read scope factory.")
  }
  const factory = storage as ObjectStorage & Partial<ObjectReadScopeFactory>
  if (typeof factory.createSelectedReadScope !== "function") {
    throw new Error("[Sixb] Expected the in-memory object-read scope factory.")
  }
  return factory as ObjectReadScopeFactory
}
