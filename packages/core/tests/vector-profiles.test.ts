import { describe, expect, mock, test } from "bun:test"
import type { ObjectQuery } from "../src"
import { defineObjectType, type EmbeddingModel, OntologyRegistry, prop } from "../src"
import { emptyGrantIndex } from "../src/authorization"
import { createAuthorizedObjectReader } from "../src/execution/authorized-object-reader"
import { createDelegatedRequestScope } from "../src/execution/scopes"
import { createModelCatalog } from "../src/models/catalog"
import { executeObjectQuery } from "../src/objects/query"
import { createSelectedObjectQueryAdmission } from "../src/objects/query/selected-read-admission"
import { validateObjectQueryWithAdmission } from "../src/objects/query/validate"
import { compileSelectedObjectReadScope } from "../src/storage/objects/read-scope"
import { getInMemoryOntologyStorageTestingAdapter } from "../src/storage/ontology/in-memory/testing"
import { createTestSixb } from "../src/testing"
import {
  atomic,
  createMaterializerFixture,
  Device,
  replacement,
  sourceEntry,
} from "./materializer-fixture"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const model: EmbeddingModel = {
  providerId: "test",
  modelId: "embedding-v1",
  definition: { kind: "embedding", providerId: "test", modelId: "embedding-v1", dimensions: 3 },
  async embed({ texts }) {
    return { vectors: texts.map(() => [1, 0, 0]) }
  },
}
const Product = defineObjectType({
  id: "Product",
  name: "Product",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("title", "string"),
    prop("description", "string"),
    prop("context", "string"),
    prop("status", "string", { query: { searchable: true, filterable: true } }),
  ],
  search: {
    vectors: {
      content: { source: ["title", "description"], model },
      context: { source: ["context"], model },
    },
  },
})
function fixture() {
  const deps = createTestRuntimeDeps()
  const embed = mock(model.embed)
  const embeddingModel = { ...model, embed }
  const sixb = createTestSixb({
    ontology: [Product],
    models: { embedding: [embeddingModel] },
    ...deps,
  })
  const objects = sixb.objects(Product)
  return { sixb, objects, embed, ...deps }
}
async function seed(f: ReturnType<typeof fixture>, id = "a") {
  return f.objects.upsert({
    properties: {
      id,
      title: "Title",
      description: "Description",
      context: "Context",
      status: "active",
    },
  })
}
async function index(
  f: ReturnType<typeof fixture>,
  id = "a",
  profile: "content" | "context" = "content",
  vector?: readonly number[]
) {
  const handle = f.objects.byId(id).vector(profile)
  if (vector) f.embed.mockResolvedValueOnce({ vectors: [vector] })
  await handle.index()
  return {
    projectId: f.sixb.execution.projectId,
    ref: { objectTypeId: Product.id, primaryId: id },
    text: f.embed.mock.calls.at(-1)?.[0].texts[0],
  }
}

describe("named vector profiles", () => {
  test("delegated text search requires all sources and ranks only selected objects", async () => {
    const f = fixture()
    await seed(f)
    await seed(f, "b")
    await index(f)
    await index(f, "b", "content", [0, 1, 0])
    f.embed.mockClear()
    const reader = (propertyIds: string[]) =>
      createAuthorizedObjectReader({
        scope: createDelegatedRequestScope({
          projectId: f.sixb.execution.projectId,
          requestId: "text-search",
          correlationId: "text-search",
          objectRead: {
            selection: {
              kind: "selected",
              roots: [
                {
                  anchor: { objectTypeId: Product.id, primaryId: "b" },
                  node: { objects: [{ objectTypeId: Product.id, propertyIds }], links: [] },
                },
              ],
            },
            limits: { maxTraversalFacts: 100, maxOutputJsonBytes: 100000 },
          },
        }),
        ontology: new OntologyRegistry({ sources: [Product] }),
        objectStorage: f.storage.objects,
        embeddingModels: createModelCatalog({ embedding: [{ ...model, embed: f.embed }] })
          .embedding,
      })
    const query = f.objects.query().vector("content", "search", { k: 1 }).ir
    await expect(reader(["id", "title"]).executeQuery({ query })).rejects.toThrow()
    expect(f.embed).not.toHaveBeenCalled()
    const result = await reader(["id", "title", "description"]).executeQuery({ query })
    expect(result.objects).toMatchObject([{ primaryId: "b", score: 0 }])
    expect(f.embed).toHaveBeenCalledTimes(1)
  })

  test("text search embeds once per terminal, does not write vectors", async () => {
    const f = fixture()
    await seed(f)
    await index(f)
    f.embed.mockClear()
    const before = getInMemoryOntologyStorageTestingAdapter(f.storage.ontology).snapshot()
    const query = f.objects.query().vector("content", "search phrase", { k: 1 })
    query.validate()
    query.explain()
    expect(f.embed).not.toHaveBeenCalled()
    expect((await query.list()).objects[0]?.score).toBe(1)
    expect(f.embed.mock.calls[0]?.[0].texts).toEqual(["search phrase"])
    expect(await query.count()).toBe(1)
    expect(await query.exists()).toBe(true)
    expect(f.embed).toHaveBeenCalledTimes(3)
    expect(query.ir).toMatchObject({ vector: "search phrase" })
    expect(getInMemoryOntologyStorageTestingAdapter(f.storage.ontology).snapshot()).toEqual(before)
  })

  test("raw authored queries reject numeric vectors before execution", async () => {
    const f = fixture()
    await seed(f)
    await index(f)
    f.embed.mockClear()
    // Regression proof: removing the authored-query guard makes this numeric query succeed.
    const query = {
      kind: "vector" as const,
      input: { kind: "start" as const, objectTypeId: Product.id },
      profile: "content",
      vector: [1, 0, 0],
      k: 1,
    }
    await expect(f.sixb.objects.executeQuery({ query })).rejects.toThrow("search text")
    await expect(
      f.sixb.objects.executeQuery({ query: { kind: "limit", input: query, limit: 1 } })
    ).rejects.toThrow("search text")
    expect(f.embed).not.toHaveBeenCalled()
  })

  test("invalid text, unsupported composition and cancellation do not call the model", async () => {
    const f = fixture()
    for (const text of ["   ", "x".repeat(8001)]) {
      await expect(f.objects.query().vector("content", text, { k: 1 }).list()).rejects.toThrow()
    }
    await expect(f.objects.query().vector("content", "search", { k: 0 }).list()).rejects.toThrow()
    await expect(
      f.objects.query().vector("content", "search", { k: 1 }).page({ pageSize: 1 }).list()
    ).rejects.toThrow()
    await expect(
      f.objects.query().vector("content", "search", { k: 1 }).list({ signal: AbortSignal.abort() })
    ).rejects.toThrow()
    expect(f.embed).not.toHaveBeenCalled()
  })

  test("malformed search embeddings fail without a retry or a stored write", async () => {
    const f = fixture()
    for (const vectors of [[], [[0, 0, 0]], [[1, 0]], [[NaN, 0, 1]]]) {
      f.embed.mockResolvedValueOnce({ vectors })
      await expect(f.objects.query().vector("content", "search", { k: 1 }).list()).rejects.toThrow()
    }
    expect(f.embed).toHaveBeenCalledTimes(4)
  })

  test("denied text search does not send text to the model", async () => {
    // Regression proof: removing assertQueryViewable before resolution invokes this spy.
    const f = fixture()
    const denied = createTestSixb(
      {
        ...createTestRuntimeDeps(),
        ontology: [Product],
        models: { embedding: [{ ...model, embed: f.embed }] },
      },
      {
        authorization: {
          principal: { type: "user", id: "denied" },
          groupIds: [],
          roleIds: [],
          grants: emptyGrantIndex(),
        },
      }
    )
    await expect(
      denied.objects(Product).query().vector("content", "private search", { k: 1 }).list()
    ).rejects.toThrow()
    expect(f.embed).not.toHaveBeenCalled()
  })

  test("index uses the configured model, independent profiles and stable scores", async () => {
    const f = fixture()
    const before = await seed(f)
    await seed(f, "b")
    const input = await index(f)
    await index(f, "b", "content", [0, 1, 0])
    await index(f, "a", "context", [0, 0, 1])
    expect(input.text).toBe('[["title","Title"],["description","Description"]]')
    const ranked = await f.objects.query().vector("content", "search", { k: 1 }).list()
    expect(ranked.objects.map((o) => o.primaryId)).toEqual(["a"])
    expect(ranked.objects[0]?.score).toBe(1)
    expect(ranked.total).toBe(1)
    expect(ranked.hasMore).toBe(false)
    const after = await f.objects.byId("a").get()
    expect(after).toEqual(before)
    expect(
      (await f.objects.query().vector("context", "search", { k: 2 }).list()).objects
    ).toHaveLength(1)
  })

  test("rejects stale object and vector revisions while embedding runs outside the transaction", async () => {
    // Regression guard: removing either revision fence makes its corresponding write succeed.
    const f = fixture()
    await seed(f)
    const handle = f.objects.byId("a").vector("content")
    for (const change of [
      () => index(f),
      () => f.objects.upsert({ properties: { id: "a", title: "Changed" } }),
    ]) {
      const started = Promise.withResolvers<void>()
      const release = Promise.withResolvers<{ vectors: number[][] }>()
      f.embed.mockImplementationOnce(() => {
        started.resolve()
        return release.promise
      })
      const pending = handle.index()
      await started.promise
      await change()
      release.resolve({ vectors: [[0, 1, 0]] })
      await expect(pending).rejects.toThrow()
    }
  })

  test("invalidates only changed sources; deletion/recreation never resurrects a vector", async () => {
    // Regression guard: remove invalidateVectorChanges from drainStagedWork to reproduce.
    const f = fixture()
    await seed(f)
    await index(f)
    await index(f, "a", "context")
    await f.objects.upsert({ properties: { id: "a", status: "paused" } })
    expect(
      (await f.objects.query().vector("content", "search", { k: 1 }).list()).objects
    ).toHaveLength(1)
    await f.objects.upsert({ properties: { id: "a", title: "Changed" } })
    expect(
      (await f.objects.query().vector("content", "search", { k: 1 }).list()).objects
    ).toHaveLength(0)
    expect(
      (await f.objects.query().vector("context", "search", { k: 1 }).list()).objects
    ).toHaveLength(1)
    await f.objects.byId("a").delete()
    await seed(f)
    expect(
      (await f.objects.query().vector("context", "search", { k: 1 }).list()).objects
    ).toHaveLength(0)
  })

  test("filters before top-k and rejects pagination or post-ranking filtering", async () => {
    const f = fixture()
    await seed(f)
    await seed(f, "b")
    await index(f)
    await index(f, "b", "content", [0, 1, 0])
    await f.objects.upsert({ properties: { id: "a", status: "paused" } })
    const result = await f.objects
      .query()
      .where((p) => p.p.status.eq("active"))
      .vector("content", "search", { k: 1 })
      .list()
    expect(result.objects.map((o) => o.primaryId)).toEqual(["b"])
    await expect(
      f.objects
        .query()
        .vector("content", "search", { k: 1 })
        .where((p) => p.p.status.eq("active"))
        .list()
    ).rejects.toThrow()
  })

  test("rejects pagination, fusion and oversized top-k", async () => {
    const f = fixture()
    await seed(f)
    await index(f)
    await expect(
      f.objects.query().vector("content", "search", { k: 1 }).page({ pageSize: 1 }).list()
    ).rejects.toThrow()
    await expect(
      f.objects.query().vector("content", "search", { k: 1001 }).list()
    ).rejects.toThrow()
    await expect(
      f.objects
        .query()
        .vector("content", "search", { k: 1 })
        .vector("context", "search", { k: 1 })
        .list()
    ).rejects.toThrow()
  })

  test("validates source lists and model dimensions before runtime use", () => {
    for (const source of [[], ["title", "title"], ["unknown"]]) {
      const invalid = defineObjectType({
        ...Product,
        search: { vectors: { content: { source, model } } },
      })
      expect(() => {
        new OntologyRegistry({ sources: [invalid] })
      }).toThrow()
    }
    for (const dimensions of [0, 1.5, 16001, Infinity]) {
      const invalid = defineObjectType({
        ...Product,
        search: {
          vectors: {
            content: {
              source: ["title"],
              model: { ...model, definition: { ...model.definition, dimensions } },
            },
          },
        },
      })
      expect(() => {
        new OntologyRegistry({ sources: [invalid] })
      }).toThrow("dimensions")
    }
  })

  test("sidecar metadata excludes values and raw writes require a materialization session", async () => {
    const f = fixture()
    await seed(f)
    const input = await index(f)
    const vectors = f.storage.ontology.vectors
    if (!vectors) throw new Error("Missing vector storage")
    const [state] = await vectors.list({ projectId: input.projectId, ref: input.ref })
    if (!state) throw new Error("Missing indexed profile")
    expect(state).not.toHaveProperty("values")
    await expect(
      vectors.write({
        projectId: input.projectId,
        session: { providerToken: {} },
        value: { ...state, values: [0, 1, 0] },
        expectedCommitId: state.lastCommitId,
      })
    ).rejects.toThrow("session")
  })

  test("rejects malformed vectors without losing the current representation", async () => {
    const f = fixture()
    await seed(f)
    await index(f)
    const handle = f.objects.byId("a").vector("content")
    for (const values of [
      [1],
      [0, 0, 0],
      [Infinity, 0, 0],
      [NaN, 0, 0],
      [1e100, 0, 0],
      [1e-100, 0, 0],
      Array<number>(3),
    ]) {
      f.embed.mockResolvedValueOnce({ vectors: [values] })
      await expect(handle.index()).rejects.toThrow()
    }
    expect(
      (await f.objects.query().vector("content", "search", { k: 1 }).list()).objects[0]?.score
    ).toBe(1)
  })

  test("provider failures and wrong result counts preserve the current vector without retry", async () => {
    // Regression guard: remove the exact result-count check in objects/vectors/handle.ts.
    const f = fixture()
    await seed(f)
    await index(f)
    const handle = f.objects.byId("a").vector("content")
    const failure = new Error("provider unavailable")
    f.embed.mockRejectedValueOnce(failure)
    await expect(handle.index()).rejects.toBe(failure)
    expect(f.embed).toHaveBeenCalledTimes(2)
    for (const vectors of [
      [],
      [
        [1, 0, 0],
        [0, 1, 0],
      ],
    ]) {
      f.embed.mockResolvedValueOnce({ vectors })
      await expect(handle.index()).rejects.toThrow("exactly one vector")
    }
    expect(f.embed).toHaveBeenCalledTimes(4)
    expect(
      (await f.objects.query().vector("content", "search", { k: 1 }).list()).objects[0]?.score
    ).toBe(1)
  })

  test("missing objects and denied authority never call the embedding provider", async () => {
    // Removing the pre-embedding authorization check sends data to the provider before denial.
    const f = fixture()
    await expect(f.objects.byId("missing").vector("content").index()).rejects.toThrow(
      "missing object"
    )
    await seed(f)
    for (const kind of ["view:object", "edit:object"] as const) {
      const sixb = createTestSixb(
        {
          id: f.sixb.execution.projectId,
          ontology: [Product],
          models: { embedding: [{ ...model, embed: f.embed }] },
          storage: f.storage,
          broker: f.broker,
          blobStorage: f.blobStorage,
          lakeStorage: f.lakeStorage,
          queues: f.queues,
        },
        {
          authorization: {
            principal: { type: "user", id: "denied" },
            groupIds: [],
            roleIds: [],
            grants: { ...emptyGrantIndex(), [kind]: new Set([Product.id]) },
          },
        }
      )
      await expect(sixb.objects(Product).byId("a").vector("content").index()).rejects.toThrow()
    }
    expect(f.embed).not.toHaveBeenCalled()
  })

  test("rollback restores vectors and objects together, including a failed reindex", async () => {
    const f = fixture()
    const before = await seed(f)
    await index(f)
    const hooks = getInMemoryOntologyStorageTestingAdapter(f.storage.ontology)
    const snapshot = hooks.snapshot()
    hooks.setTestHooks({
      beforeWrite(boundary) {
        if (boundary === "finalize") throw new Error("injected finalization failure")
      },
    })
    await expect(f.objects.upsert({ properties: { id: "a", title: "Broken" } })).rejects.toThrow(
      "injected"
    )
    expect(await f.objects.byId("a").get()).toEqual(before)
    expect(hooks.snapshot()).toEqual(snapshot)
    await expect(index(f, "a", "content", [0, 1, 0])).rejects.toThrow("injected")
    expect(hooks.snapshot()).toEqual(snapshot)
    hooks.setTestHooks({})
    expect(
      (await f.objects.query().vector("content", "search", { k: 1 }).list()).objects[0]?.score
    ).toBe(1)
  })

  test("a selected reader ranks only authorized objects and requires every source", async () => {
    const f = fixture()
    await seed(f)
    await seed(f, "b")
    const prepared = await index(f)
    await index(f, "b", "content", [0, 1, 0])
    const ontology = new OntologyRegistry({ sources: [Product] })
    const scope = compileSelectedObjectReadScope({
      kind: "selected",
      roots: [
        {
          anchor: { objectTypeId: "Product", primaryId: "b" },
          node: {
            objects: [{ objectTypeId: "Product", propertyIds: ["id", "title", "description"] }],
            links: [],
          },
        },
      ],
    })
    const reader = f.storage.objects.createSelectedReadScope({
      projectId: prepared.projectId,
      scope,
      limits: { maxTraversalFacts: 10, maxOutputJsonBytes: 10000 },
    })
    const query: ObjectQuery = {
      kind: "vector",
      input: { kind: "start", objectTypeId: "Product" },
      profile: "content",
      vector: [1, 0, 0],
      k: 1,
    }
    const result = await executeObjectQuery(
      { projectId: prepared.projectId, query },
      { ontology, storage: reader }
    )
    expect(result.objects.map((o) => o.primaryId)).toEqual(["b"])
    expect(result.objects[0]?.score).toBe(0)
    const hidden = compileSelectedObjectReadScope({
      kind: "selected",
      roots: [
        {
          anchor: { objectTypeId: "Product", primaryId: "b" },
          node: { objects: [{ objectTypeId: "Product", propertyIds: ["id", "title"] }], links: [] },
        },
      ],
    })
    expect(() =>
      validateObjectQueryWithAdmission(
        query,
        { ontology },
        createSelectedObjectQueryAdmission(hidden)
      )
    ).toThrow()
    // Storage is also defensive when called without canonical admission.
    const hiddenReader = f.storage.objects.createSelectedReadScope({
      projectId: prepared.projectId,
      scope: hidden,
      limits: { maxTraversalFacts: 10, maxOutputJsonBytes: 10000 },
    })
    expect(
      (
        await executeObjectQuery(
          { projectId: prepared.projectId, query },
          { ontology, storage: hiddenReader }
        )
      ).objects
    ).toHaveLength(0)
  })

  test("configuration changes exclude old representations without rewriting the object", async () => {
    const f = fixture()
    const before = await seed(f)
    const prepared = await index(f)
    const next = defineObjectType({
      ...Product,
      search: { vectors: { content: { source: ["description", "title"], model } } },
    })
    const sixb = createTestSixb({
      id: prepared.projectId,
      ontology: [next],
      models: { embedding: [model] },
      storage: f.storage,
      broker: f.broker,
      blobStorage: f.blobStorage,
      lakeStorage: f.lakeStorage,
      queues: f.queues,
    })
    expect(
      (await sixb.objects(next).query().vector("content", "search", { k: 1 }).list()).objects
    ).toHaveLength(0)
    expect<unknown>(await sixb.objects(next).byId("a").get()).toEqual(before)
    const handle = sixb.objects(next).byId("a").vector("content")
    await handle.index()
    expect(
      (await sixb.objects(next).query().vector("content", "search", { k: 1 }).list()).objects
    ).toHaveLength(1)
  })

  test("rejects unsupported storage and unregistered models at startup", () => {
    const deps = createTestRuntimeDeps()
    expect(() => {
      createTestSixb({ ontology: [Product], ...deps })
    }).toThrow("models.embedding")
    const storage = new Proxy(deps.storage, {
      get(target, key, receiver) {
        return key === "ontology"
          ? { ...target.ontology, vectors: undefined }
          : Reflect.get(target, key, receiver)
      },
    })
    // A provider missing the new capability must fail before serving this ontology.
    expect(() => {
      createTestSixb({ ontology: [Product], models: { embedding: [model] }, ...deps, storage })
    }).toThrow("transactional vector profiles")
  })

  test("projection replacement, reset, telemetry and restore share the vector lifecycle", async () => {
    const type = defineObjectType({
      ...Device,
      search: { vectors: { content: { source: ["name"], model } } },
    })
    const f = createMaterializerFixture({ search: type.search })
    const sixb = createTestSixb({
      id: "project",
      ontology: [type],
      models: { embedding: [model] },
      ...createTestRuntimeDeps(),
      storage: f.storage,
    })
    const object = sixb.objects(type).byId("one")
    const vector = object.vector("content")
    const write = () => vector.index()
    const matches = async () =>
      (await sixb.objects(type).query().vector("content", "search", { k: 1 }).list()).objects.length
    await f.materializer.projections.replace(
      replacement("v1", "2026-01-01T00:00:00.000Z", [sourceEntry("one", "Alpha")])
    )
    await write()
    await object
      .telemetry(type.p.temperature)
      .append({ value: 20, at: new Date("2026-01-01T01:00:00Z") })
    expect(await matches()).toBe(1)
    await f.materializer.projections.replace(
      replacement("v2", "2026-01-02T00:00:00.000Z", [sourceEntry("one", "Beta")])
    )
    expect(await matches()).toBe(0)
    await sixb.objects(type).upsert({ properties: { id: "one", name: "Override" } })
    await write()
    await f.materializer.edits.commit(
      atomic("reset-vector-source", [
        {
          id: "reset",
          kind: "object.patch",
          ref: { objectTypeId: "Device", primaryId: "one" },
          set: {},
          unset: [],
          reset: ["name"],
        },
      ])
    )
    expect(await matches()).toBe(0)
    expect((await object.get())?.properties.name).toBe("Beta")
    await write()
    await object.delete()
    await object.restore()
    expect(await matches()).toBe(0)
  })

  test("simultaneous reindexing accepts exactly one result for a prepared revision", async () => {
    const f = fixture()
    await seed(f)
    const handle = f.objects.byId("a").vector("content")
    const bothStarted = Promise.withResolvers<void>()
    const release = Promise.withResolvers<{ vectors: number[][] }>()
    let started = 0
    f.embed.mockImplementation(() => {
      if (++started === 2) bothStarted.resolve()
      return release.promise
    })
    const pending = [handle.index(), handle.index()]
    await bothStarted.promise
    release.resolve({ vectors: [[1, 0, 0]] })
    const results = await Promise.allSettled(pending)
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1)
  })

  test("ontology snapshots contain metadata only", () => {
    const registry = new OntologyRegistry({ sources: [Product] })
    const ref = registry.resolveObjectType("Product").search?.vectors?.content?.model
    expect(ref).not.toHaveProperty("embed")
    expect(ref).toEqual({
      providerId: "test",
      modelId: "embedding-v1",
      definition: model.definition,
    })
  })
})
