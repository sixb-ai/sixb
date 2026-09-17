import { describe, expect, test } from "bun:test"
import { defineObjectType, type EmbeddingModel, OntologyRegistry, prop } from "../src"
import type { JsonValue } from "../src/json"
import { validateObjectQuery } from "../src/objects/query"
import { compileSelectedObjectReadScope, linkBatchKey } from "../src/storage"
import { InMemoryStorage } from "../src/storage/in-memory"
import {
  getInMemoryObjectMaterializerAdapter,
  InMemoryObjectStorage,
} from "../src/storage/objects/in-memory"
import { createTestSixb, runObjectReadScopeContractSuite } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

runObjectReadScopeContractSuite("InMemoryStorage selected object-read scope contract", {
  createHarness: () => {
    const storage = new InMemoryStorage()
    return { storage, objectReadScopeFactory: storage.objects }
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
    const model: EmbeddingModel = {
      providerId: "test",
      modelId: "scope",
      definition: { kind: "embedding", providerId: "test", modelId: "scope", dimensions: 2 },
      async embed({ texts }) {
        return { vectors: texts.map((text) => (text.includes("Visible") ? [0, 1] : [1, 0])) }
      },
    }
    const Proposal = defineObjectType({
      id: "ScopeProposal",
      name: "Proposal",
      properties: [
        prop("id", "string", { primary: true, required: true }),
        prop("title", "string"),
      ],
      search: { vectors: { content: { source: ["title"], model } } },
    })
    const deps = createTestRuntimeDeps()
    const sixb = createTestSixb({ ontology: [Proposal], models: { embedding: [model] }, ...deps })
    const { storage } = deps
    const projectId = sixb.execution.projectId
    for (const [id, title] of [
      ["visible", "Visible"],
      ["hidden", "Hidden"],
    ] as const) {
      await sixb.objects(Proposal).upsert({ properties: { id, title } })
      await sixb.objects(Proposal).byId(id).vector("content").index()
    }

    const reader = storage.objects.createSelectedReadScope({
      projectId,
      scope: compileSelectedObjectReadScope({
        kind: "selected",
        roots: [
          {
            anchor: { objectTypeId: "ScopeProposal", primaryId: "visible" },
            node: {
              objects: [{ objectTypeId: "ScopeProposal", propertyIds: ["id", "title"] }],
              links: [],
            },
          },
        ],
      }),
      limits: { maxTraversalFacts: 10, maxOutputJsonBytes: 10_000 },
    })
    const result = await reader.queryObjects?.({
      projectId,
      query: validateObjectQuery(
        {
          kind: "vector",
          input: { kind: "start", objectTypeId: Proposal.id },
          profile: "content",
          vector: [1, 0],
          k: 1,
        },
        { ontology: new OntologyRegistry({ sources: [Proposal] }) }
      ).query,
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
