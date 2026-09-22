import { describe, expect, mock, test } from "bun:test"
import {
  defineObjectType,
  type EmbeddingModel,
  type EmbeddingModelResult,
  OntologyRegistry,
  prop,
  type SixbErrorContext,
  SixbHost,
} from "../src"
import { createKernelScope } from "../src/execution/scopes"
import { createOntologyMaterializer } from "../src/materializer/materializer"
import { EmbeddingModelResponseError } from "../src/models/embedding-model"
import { VectorIndexingDeferred } from "../src/objects/vectors/indexing"
import { getVectorIndexingRuntime } from "../src/objects/vectors/indexing-runtime"
import { vectorSources } from "../src/objects/vectors/profile"
import { ProjectionRegistry } from "../src/projections/registry"
import { getInMemoryOntologyStorageTestingAdapter } from "../src/storage/ontology/in-memory/testing"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

function fixture(resolve?: EmbeddingModel["resolve"]) {
  const deps = createTestRuntimeDeps()
  const failures: SixbErrorContext[] = []
  const embed = mock(
    async (): Promise<EmbeddingModelResult> => ({
      vectors: [[1, 0]],
      usage: { inputTokens: 10 },
      reportedCost: { money: { currency: "USD", amountNanos: "100" } },
    })
  )
  const model: EmbeddingModel = {
    providerId: "test",
    modelId: "embedding",
    definition: { kind: "embedding", providerId: "test", modelId: "embedding", dimensions: 2 },
    embed,
    resolve,
  }
  const Product = defineObjectType({
    id: "Product",
    name: "Product",
    properties: [
      prop("id", "string", { primary: true, required: true }),
      prop("description", "string"),
      prop("status", "string"),
    ],
    search: { vectors: { content: { source: ["description"], model } } },
  })
  const host = new SixbHost({
    id: "indexing",
    ontology: [Product],
    models: { embedding: [model] },
    onError: (_error, context) => {
      failures.push(context)
    },
    ...deps,
  })
  const sixb = createTestSixb(host)
  const objects = sixb.objects(Product)
  const indexing = deps.storage.ontology.vectorIndexing!
  const due = () =>
    indexing.listDue({ projectId: host.id, now: "2100-01-01T00:00:00.000Z", limit: 100 })
  const process = (id: string) =>
    getVectorIndexingRuntime(host).process(id, 1, new AbortController().signal)
  const write = (description: string, status = "draft") =>
    objects.upsert({ properties: { id: "p", description, status } })
  const vectors = () =>
    deps.storage.ontology.vectors!.list({
      projectId: host.id,
      ref: { objectTypeId: "Product", primaryId: "p" },
    })
  return { ...deps, host, objects, indexing, due, process, write, vectors, embed, failures, model }
}

describe("automatic vector indexing", () => {
  test("coalesces changes to effective sources and ignores unrelated properties", async () => {
    // Removal proof: omit scheduleVectorChanges in drainStagedWork; the first assertion fails.
    const f = fixture()
    await f.write("first")
    const [first] = await f.due()
    expect(first).toMatchObject({ profile: "content", status: "pending" })
    await f.write("second")
    const [second] = await f.due()
    expect(second!.id).not.toBe(first!.id)
    await f.write("second", "published")
    expect((await f.due()).map((work) => work.id)).toEqual([second!.id])
    await f.process(first!.id)
    expect(f.embed).not.toHaveBeenCalled()
    await f.process(second!.id)
    expect(f.embed).toHaveBeenCalledTimes(1)
    expect(await f.vectors()).toHaveLength(1)
    expect(await f.due()).toEqual([])
    await f.process(second!.id)
    expect(f.embed).toHaveBeenCalledTimes(1)
  })

  test("accounts automatic inference to project execution with commit provenance", async () => {
    const f = fixture()
    await f.write("source")
    const [work] = await f.due()
    await f.process(work!.id)
    const execution = await f.storage.executions.getById({
      projectId: f.host.id,
      id: `exec_vector_${work!.id}`,
    })
    expect(execution).toMatchObject({
      executor: {
        type: "kernel",
        operation: { type: "ontology.indexVectors", indexingId: work!.id },
      },
      source: { type: "ontologyCommit", commitId: work!.sourceCommitId },
      requesterGroupIds: [],
    })
    expect(execution?.requestedBy).toBeUndefined()
    expect(
      await f.storage.aiUsage.summarizeExecution({
        projectId: f.host.id,
        executionId: execution!.id,
      })
    ).toMatchObject({ modelCallCount: 1, usage: { inputTokens: 10 } })
  })

  test("superseded work cannot reserve budget or record a fictitious provider call", async () => {
    // Removal proof: admit before the indexing fence in ModelExecutionSession; reserved capacity stays nonzero.
    const f = fixture(async () => {
      await f.write("second")
      return f.model
    })
    await f.storage.aiLimits.createPolicy({
      id: "tokens",
      projectId: f.host.id,
      subject: { type: "project" },
      limit: { meter: "tokens.total", amount: 1000 },
    })
    await f.write("first")
    const [work] = await f.due()
    await f.process(work!.id)
    expect(f.embed).not.toHaveBeenCalled()
    expect(
      await f.storage.aiUsage.summarizeExecution({
        projectId: f.host.id,
        executionId: `exec_vector_${work!.id}`,
      })
    ).toMatchObject({ modelCallCount: 0 })
    expect(await f.storage.aiLimits.listPolicyStatuses({ projectId: f.host.id })).toMatchObject([
      { consumption: { reserved: { amount: 0 } } },
    ])
    expect((await f.due())[0]!.id).not.toBe(work!.id)
  })

  test("budget exhaustion defers inference without blocking object writes", async () => {
    const f = fixture()
    await f.storage.aiLimits.createPolicy({
      id: "budget",
      projectId: f.host.id,
      subject: { type: "project" },
      limit: { meter: "tokens.total", amount: 1 },
    })
    await f.write("a source longer than the token budget")
    const [work] = await f.due()
    await expect(f.process(work!.id)).rejects.toBeInstanceOf(VectorIndexingDeferred)
    expect(f.embed).not.toHaveBeenCalled()
    expect(await f.indexing.get({ projectId: f.host.id, id: work!.id })).toMatchObject({
      status: "pending",
    })
    await f.write("updated while indexing is paused")
    expect((await f.due())[0]!.id).not.toBe(work!.id)
  })

  test("source changes during inference discard the result and preserve newer work", async () => {
    // A stale delivery must neither publish its result nor erase the newer generation.
    const f = fixture()
    await f.write("first")
    const [first] = await f.due()
    f.embed.mockImplementationOnce(async () => {
      await f.write("second")
      return { vectors: [[1, 0]] }
    })
    await f.process(first!.id)
    expect(await f.vectors()).toHaveLength(0)
    const [second] = await f.due()
    expect(second!.id).not.toBe(first!.id)
    await f.process(second!.id)
    expect(await f.vectors()).toHaveLength(1)
  })

  test("unrelated edits renew the object fence without another inference", async () => {
    const f = fixture()
    await f.write("source")
    const [work] = await f.due()
    f.embed.mockImplementationOnce(async () => {
      await f.write("source", "published")
      return { vectors: [[1, 0]] }
    })
    await f.process(work!.id)
    expect(f.embed).toHaveBeenCalledTimes(1)
    expect(await f.vectors()).toHaveLength(1)
  })

  test("deletion and recreation cannot publish a result for the former object", async () => {
    const f = fixture()
    await f.write("source")
    const [work] = await f.due()
    f.embed.mockImplementationOnce(async () => {
      await f.objects.byId("p").delete()
      await f.write("source")
      return { vectors: [[1, 0]] }
    })
    await f.process(work!.id)
    expect(await f.vectors()).toHaveLength(0)
    expect((await f.due())[0]!.id).not.toBe(work!.id)
  })

  test("an interrupted provider attempt fails visibly without repeating inference", async () => {
    const f = fixture()
    await f.write("source")
    const [work] = await f.due()
    await f.indexing.update({
      projectId: f.host.id,
      id: work!.id,
      expectedStatus: "pending",
      status: "running",
      availableAt: new Date().toISOString(),
    })
    await f.process(work!.id)
    expect(f.embed).not.toHaveBeenCalled()
    expect(await f.indexing.get({ projectId: f.host.id, id: work!.id })).toMatchObject({
      status: "failed",
      error: { code: "vector.outcome_unknown", retryable: false },
    })
    expect(f.failures).toContainEqual(
      expect.objectContaining({ type: "vector.indexing.failed", indexingId: work!.id })
    )
  })

  test.each([
    "count",
    "dimensions",
    "values",
    "provider",
  ] as const)("invalid %s response remains accounted and is not retried", async (kind) => {
    // Removal proof: remove response-error classification; the persisted/notification code fails.
    const f = fixture()
    await f.write("source")
    const [work] = await f.due()
    f.embed.mockImplementationOnce(async () => {
      if (kind === "provider") {
        throw new EmbeddingModelResponseError("invalid", "test", "embedding", {
          usage: { inputTokens: 10 },
        })
      }
      return {
        vectors: kind === "count" ? [] : kind === "dimensions" ? [[1]] : [[0, 0]],
        usage: { inputTokens: 10 },
      }
    })
    await f.process(work!.id)
    const failed = await f.indexing.get({ projectId: f.host.id, id: work!.id })
    expect(failed).toMatchObject({
      status: "failed",
      error: { code: "vector.response_invalid", retryable: false },
    })
    expect(f.failures).toContainEqual(
      expect.objectContaining({
        type: "vector.indexing.failed",
        indexingId: work!.id,
        failure: failed!.error,
      })
    )
    expect(
      await f.storage.aiUsage.summarizeExecution({
        projectId: f.host.id,
        executionId: `exec_vector_${work!.id}`,
      })
    ).toMatchObject({ modelCallCount: 1, usage: { inputTokens: 10 } })
    await f.process(work!.id)
    expect(f.embed).toHaveBeenCalledTimes(1)
    expect(await f.vectors()).toHaveLength(0)
  })

  test("a persisted result resumes storage without repeating inference", async () => {
    const f = fixture()
    await f.write("source")
    const [work] = await f.due()
    await f.indexing.update({
      projectId: f.host.id,
      id: work!.id,
      expectedStatus: "pending",
      status: "ready",
      availableAt: new Date().toISOString(),
      values: [1, 0],
    })
    await f.process(work!.id)
    expect(f.embed).not.toHaveBeenCalled()
    expect(await f.vectors()).toHaveLength(1)
  })

  test("object rollback also rolls back indexing intent", async () => {
    const f = fixture()
    const adapter = getInMemoryOntologyStorageTestingAdapter(f.storage.ontology)
    adapter.setTestHooks({
      beforeWrite(boundary) {
        if (boundary === "finalize") throw new Error("rollback")
      },
    })
    await expect(f.write("source")).rejects.toThrow("rollback")
    expect(await f.due()).toHaveLength(0)
  })

  test("indexing authority cannot replace its persisted result with different values", async () => {
    // Removal proof: omit matchesStoredResult in authorizeVectorIndexingCommit; this write succeeds.
    const f = fixture()
    await f.write("source")
    const [work] = await f.due()
    await f.indexing.update({
      projectId: f.host.id,
      id: work!.id,
      expectedStatus: "pending",
      status: "ready",
      values: [1, 0],
      availableAt: new Date().toISOString(),
    })
    const row = await f.storage.objects.getByPrimaryId({ projectId: f.host.id, ...work!.ref })
    const scope = createKernelScope({
      projectId: f.host.id,
      operation: { type: "ontology.indexVectors", indexingId: work!.id },
      source: { type: "ontologyCommit", commitId: work!.sourceCommitId },
    })
    const expected = {
      ref: work!.ref,
      exists: true as const,
      version: row!.version,
      lastCommitId: row!.lastCommitId,
    }
    const ontology = new OntologyRegistry({
      sources: f.host.definitions.ontology.listObjectTypes(),
    })
    const materializer = createOntologyMaterializer({
      projectId: f.host.id,
      ontology,
      projections: new ProjectionRegistry({ ontology, datasetsById: new Map(), projections: [] }),
      storage: f.storage,
    })
    await expect(
      materializer.edits.commit({
        scope,
        input: {
          mode: "atomic",
          source: { kind: "runtime", requestId: "wrong-vector" },
          operations: [],
          expectedObjects: [expected],
          expectedLinks: [],
          expectedLinkScopes: [],
          vectorWrites: [
            {
              input: {
                projectId: f.host.id,
                ref: work!.ref,
                profile: work!.profile,
                configuration: work!.configuration,
                ...vectorSources(["description"], row!.properties),
                expectedObject: expected,
                expectedVectorCommitId: null,
              },
              values: [0, 1],
            },
          ],
        },
      })
    ).rejects.toThrow("only permits its current prepared representation")
    expect(await f.vectors()).toHaveLength(0)
  })

  test("manual indexing clears a matching pending request atomically", async () => {
    const f = fixture()
    await f.write("source")
    const [work] = await f.due()
    await f.objects.byId("p").vector("content").index()
    expect(await f.indexing.get({ projectId: f.host.id, id: work!.id })).toBeNull()
    await f.process(work!.id)
    expect(f.embed).toHaveBeenCalledTimes(1)
  })

  test("an internal indexing scope cannot bind the domain SDK", () => {
    const f = fixture()
    const scope = createKernelScope({
      projectId: f.host.id,
      operation: { type: "ontology.indexVectors", indexingId: "work" },
      source: { type: "ontologyCommit", commitId: "commit" },
    })
    expect(() => f.host.withScope(scope)).toThrow("Kernel authority cannot be bound")
  })
})

test("automatic indexing rejects catalog representation drift before inference", async () => {
  const f = fixture()
  await f.write("source")
  const [work] = await f.due()
  Object.defineProperty(f.model, "definition", {
    value: { ...f.model.definition, representation: { name: "different-model", version: "2" } },
  })
  await f.process(work!.id)
  expect(f.embed).not.toHaveBeenCalled()
  expect(await f.vectors()).toEqual([])
  expect(await f.indexing.get({ projectId: f.host.id, id: work!.id })).toMatchObject({
    status: "failed",
    error: { code: "vector.model_unavailable" },
  })
})
