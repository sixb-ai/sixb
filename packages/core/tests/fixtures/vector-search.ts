import assert from "node:assert/strict"
import { defineObjectType, type EmbeddingModel, OntologyRegistry, prop, SixbHost } from "../../src"
import { executeObjectQuery } from "../../src/objects/query"
import { compileSelectedObjectReadScope, type Storage } from "../../src/storage"
import { createTestSixb } from "../../src/testing"
import { createTestRuntimeDeps } from "../test-runtime-deps"

/** Shared semantic checks for actual SQL engines; no engine or distance mocks. */
export async function verifyVectorSearch(
  storage: Storage,
  fill?: () => Promise<void>
): Promise<void> {
  const model: EmbeddingModel = {
    providerId: "test",
    modelId: "vectors",
    definition: { kind: "embedding", providerId: "test", modelId: "vectors", dimensions: 3 },
    async embed({ texts }) {
      return {
        vectors: texts.map((text) =>
          text.includes("North")
            ? [1e20, 0, 0]
            : text.includes("South")
              ? [-1e-30, 0, 0]
              : [0, 1, 0]
        ),
      }
    },
  }
  const Product = defineObjectType({
    id: "SearchProduct",
    name: "Product",
    properties: [
      prop("id", "string", { primary: true, required: true }),
      prop("title", "string"),
      prop("status", "string", { query: { searchable: true, filterable: true, facet: true } }),
    ],
    search: { vectors: { content: { source: ["title"], model } } },
  })
  const host = new SixbHost({
    ...createTestRuntimeDeps(),
    id: "vector-search",
    ontology: [Product],
    models: { embedding: [model] },
    storage,
  })
  await host.closeBroker()
  const objects = createTestSixb(host).objects(Product)
  for (const [id, title, status] of [
    ["a", "North", "hidden"],
    ["b", "East", "visible"],
    ["c", "South", "visible"],
    ["d", "North", "visible"],
  ]) {
    await objects.upsert({ properties: { id: id!, title: title!, status: status! } })
    await objects.byId(id!).vector("content").index()
  }
  const result = await objects.query().vector("content", [1e-30, 0, 0], { k: 4 }).list()
  assert.deepEqual(
    result.objects.map((o) => o.primaryId),
    ["a", "d", "b", "c"]
  )
  for (const [i, score] of [1, 1, 0, -1].entries())
    assert.ok(Math.abs(result.objects[i]!.score! - score) < 1e-5)
  assert.equal(result.total, 4)
  assert.equal(result.hasMore, false)
  const filtered = await objects
    .query()
    .where((p) => p.p.status.eq("visible"))
    .vector("content", [1, 0, 0], { k: 2 })
    .list()
  assert.deepEqual(
    filtered.objects.map((o) => o.primaryId),
    ["d", "b"]
  )
  assert.equal(await objects.query().vector("content", [1, 0, 0], { k: 2 }).count(), 2)
  assert.equal(await objects.query().vector("content", [1, 0, 0], { k: 2 }).exists(), true)
  const limited = await objects.query().vector("content", [1, 0, 0], { k: 3 }).limit(1).list()
  assert.deepEqual(
    limited.objects.map((o) => o.primaryId),
    ["a"]
  )
  assert.equal(limited.total, 3)
  const state = (
    await storage.ontology.vectors!.list({
      projectId: "vector-search",
      ref: { objectTypeId: Product.id, primaryId: "a" },
    })
  )[0]!
  const query = {
    kind: "vector" as const,
    input: { kind: "start" as const, objectTypeId: Product.id },
    profile: "content",
    configuration: state.configuration,
    vector: [1, 0, 0],
    k: 1,
  }
  const ontology = new OntologyRegistry({ sources: [Product] })
  const projected = await executeObjectQuery(
    { projectId: "vector-search", query: { kind: "project", input: query, properties: ["id"] } },
    { storage: storage.objects, ontology }
  )
  assert.deepEqual(projected.objects[0]!.properties, { id: "a" })
  assert.equal(projected.objects[0]!.score, 1)
  const scope = compileSelectedObjectReadScope({
    kind: "selected",
    roots: [
      {
        anchor: { objectTypeId: Product.id, primaryId: "b" },
        node: {
          objects: [{ objectTypeId: Product.id, propertyIds: ["id", "title", "status"] }],
          links: [],
        },
      },
      {
        anchor: { objectTypeId: Product.id, primaryId: "d" },
        node: { objects: [{ objectTypeId: Product.id, propertyIds: ["id", "status"] }], links: [] },
      },
    ],
  })
  const reader = storage.objects.createSelectedReadScope({
    projectId: "vector-search",
    scope,
    limits: { maxTraversalFacts: 100, maxOutputJsonBytes: 100000 },
  })
  // Regression proof: remove the source-permission clause from the SQL vector compiler.
  const authorized = await reader.queryObjects!({ projectId: "vector-search", query })
  assert.deepEqual(
    authorized.objects.map((o) => o.primaryId),
    ["b"]
  )
  assert.equal(authorized.objects[0]!.score, 0)
  assert.equal(authorized.total, 1)
  assert.equal((await reader.countObjects!({ projectId: "vector-search", query })).count, 1)
  assert.deepEqual(
    (await storage.objects.queryObjects!({ projectId: "another-project", query })).objects,
    []
  )
  assert.deepEqual(
    (
      await storage.objects.queryObjects!({
        projectId: "vector-search",
        query: { ...query, configuration: "old" },
      })
    ).objects,
    []
  )
  await objects.upsert({ properties: { id: "a", title: "Changed" } })
  assert.deepEqual(
    (await objects.query().vector("content", [1, 0, 0], { k: 1 }).list()).objects.map(
      (o) => o.primaryId
    ),
    ["d"]
  )
  const facets = await objects
    .query()
    .vector("content", [1, 0, 0], { k: 2 })
    .facets([{ property: Product.p.status, limit: 10 }])
  assert.equal(
    facets[0]!.buckets.reduce((sum, bucket) => sum + bucket.count, 0),
    2
  )
  await assert.rejects(() =>
    objects
      .query()
      .vector("content", [1, 0, 0], { k: 1 })
      .where((p) => p.p.status.eq("visible"))
      .list()
  )
  for (const id of ["𐀀", "\uE000", "A", "a-2"]) {
    await objects.upsert({ properties: { id, title: "North", status: "tie" } })
    await objects.byId(id).vector("content").index()
  }
  assert.deepEqual(
    (
      await objects
        .query()
        .where((p) => p.p.status.eq("tie"))
        .vector("content", [1, 0, 0], { k: 4 })
        .list()
    ).objects.map((o) => o.primaryId),
    ["A", "a-2", "\uE000", "𐀀"]
  )
  if (fill) {
    await fill()
    // Regression proof: disable the vectorProbe count check; this assertion must fail.
    await assert.rejects(
      () => objects.query().vector("content", [1, 0, 0], { k: 1 }).list(),
      /vector.*limit|at most/i
    )
  }
  console.log(
    "Vector search: ranking, normalization, filters, limits, terminals, authorization, configuration and invalidation passed"
  )
}
