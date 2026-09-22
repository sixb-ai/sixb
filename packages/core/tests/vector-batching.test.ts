import { describe, expect, mock, spyOn, test } from "bun:test"
import {
  defineObjectType,
  type EmbeddingBatchLimits,
  type EmbeddingModel,
  type EmbeddingModelRequest,
  type SixbErrorContext,
  SixbHost,
} from "../src"
import { createKernelScope } from "../src/execution/scopes"
import { createOntologyMaterializer } from "../src/materializer/materializer"
import { VectorIndexingDeferred } from "../src/objects/vectors/indexing"
import { getVectorIndexingRuntime } from "../src/objects/vectors/indexing-runtime"
import { commitPreparedVectors, prepare } from "../src/objects/vectors/indexing-shared"
import { storeVectorBatch } from "../src/objects/vectors/indexing-store-batch"
import { normalizeVector, vectorSources } from "../src/objects/vectors/profile"
import type { SixbHostContext } from "../src/runtime/types"
import { getInMemoryOntologyStorageTestingAdapter } from "../src/storage/ontology/in-memory/testing"
import type { VectorIndexingWork } from "../src/storage/ontology/vector-indexing"
import { createTestSixb } from "../src/testing"
import { createMaterializerFixture, Device, replacement, sourceEntry } from "./materializer-fixture"
import { createTestRuntimeDeps } from "./test-runtime-deps"

function fixture(
  options: {
    batching?: boolean
    limits?: EmbeddingBatchLimits
    resolve?: EmbeddingModel["resolve"]
  } = {}
) {
  const embed = mock(async ({ texts }: EmbeddingModelRequest) => ({
    vectors: texts.map((text) => [text.length, 1]),
    usage: { inputTokens: 10 },
    reportedCost: { money: { currency: "USD" as const, amountNanos: "100" } },
  }))
  const model: EmbeddingModel = {
    providerId: "test",
    modelId: "embedding",
    definition: { kind: "embedding", providerId: "test", modelId: "embedding", dimensions: 2 },
    ...(options.batching === false
      ? {}
      : {
          batching: options.limits ?? {
            maxInputs: 32,
            maxInputBytes: 8192,
            maxTotalInputBytes: 32768,
          },
        }),
    embed,
    resolve: options.resolve,
  }
  const type = defineObjectType({
    ...Device,
    search: { vectors: { content: { source: ["name"], model } } },
  })
  const f = createMaterializerFixture({ search: type.search })
  const failures: SixbErrorContext[] = []
  const host = new SixbHost({
    id: "project",
    ontology: [type],
    models: { embedding: [model] },
    ...createTestRuntimeDeps(),
    storage: f.storage,
    onError: (_error, context) => {
      failures.push(context)
    },
  })
  const runtime: SixbHostContext = {
    projectId: host.id,
    ontology: f.ontology,
    embeddingModels: host.definitions.models?.embedding,
    actionRegistry: host.definitions.actions,
    broker: host.broker,
    events: host.events,
    queues: host.queues,
    storage: f.storage,
  }
  const writer = createOntologyMaterializer({
    projectId: host.id,
    ontology: f.ontology,
    projections: f.projections,
    storage: f.storage,
  })
  const objects = createTestSixb(host).objects(type)
  const indexing = f.storage.ontology.vectorIndexing!
  let version = 0
  const project = (names: string[]) =>
    f.materializer.projections.replace(
      replacement(
        `v${++version}`,
        new Date(Date.UTC(2026, 0, version)).toISOString(),
        names.map((name, i) => sourceEntry(String(i), name))
      )
    )
  const due = () =>
    indexing.listDue({ projectId: host.id, now: "2100-01-01T00:00:00.000Z", limit: 1000 })
  const process = (id: string) =>
    getVectorIndexingRuntime(host).process(id, 1, new AbortController().signal)
  const vectors = (id: string) =>
    f.storage.ontology.vectors!.list({
      projectId: host.id,
      ref: { objectTypeId: type.id, primaryId: id },
    })
  const usage = (id: string) =>
    f.storage.aiUsage.summarizeExecution({ projectId: host.id, executionId: `exec_vector_${id}` })
  return {
    ...f,
    runtime,
    writer,
    host,
    model,
    embed,
    objects,
    indexing,
    project,
    due,
    process,
    vectors,
    usage,
    failures,
  }
}

describe("durable projection embedding batches", () => {
  test("projects multiple objects, embeds once, and accounts one project call", async () => {
    // Removal proof: disable projection grouping in drainStagedWork; the shared batch assertion fails.
    const f = fixture()
    const names = ["Alpha", "Longer description", "Third"]
    await f.project(names)
    expect(f.embed).not.toHaveBeenCalled()
    const work = await f.due()
    const batchId = work[0]!.batchId!
    expect(batchId).toBeString()
    expect(new Set(work.map((entry) => entry.batchId)).size).toBe(1)
    await f.process(batchId)
    expect(f.embed).toHaveBeenCalledTimes(1)
    expect(f.embed.mock.calls[0]![0].texts).toHaveLength(3)
    for (const [i, name] of names.entries()) {
      const text = vectorSources(["name"], { name }).text
      expect(
        [
          ...getInMemoryOntologyStorageTestingAdapter(f.storage.ontology)
            .snapshot()
            .vectors.values(),
        ]
          .flatMap((profiles) => [...profiles.values()])
          .find((vector) => vector.ref.primaryId === String(i))!.values
      ).toEqual(normalizeVector([text.length, 1], 2))
    }
    // Removal proof: publish with storeVector per member; these commit ids differ.
    const states = await Promise.all(names.map((_, i) => f.vectors(String(i))))
    expect(new Set(states.flat().map((vector) => vector.lastCommitId)).size).toBe(1)
    expect(await f.usage(batchId)).toMatchObject({ modelCallCount: 1, usage: { inputTokens: 10 } })
    expect(
      await f.storage.executions.getById({ projectId: f.host.id, id: `exec_vector_${batchId}` })
    ).toMatchObject({
      source: { type: "ontologyCommit", commitId: work[0]!.sourceCommitId },
      requesterGroupIds: [],
    })
    const costs = await f.storage.aiCosts.listModelCalls({
      projectId: f.host.id,
      from: new Date("2000-01-01"),
      to: new Date("2100-01-01"),
    })
    expect(costs.items).toHaveLength(1)
    expect(costs.items[0]!.cost).toMatchObject({ status: "rated", money: { amountNanos: "100" } })
    expect(await f.due()).toEqual([])
    await f.process(batchId)
    expect(f.embed).toHaveBeenCalledTimes(1)
  })

  test("bounds durable membership by count and serialized source bytes", async () => {
    const f = fixture()
    await f.project(Array.from({ length: 33 }, (_, i) => `item${i}`))
    const groups = new Map<string, number>()
    for (const work of await f.due())
      groups.set(work.batchId!, (groups.get(work.batchId!) ?? 0) + 1)
    expect([...groups.values()].sort((a, b) => a - b)).toEqual([1, 32])
    const large = fixture()
    await large.project(Array.from({ length: 5 }, () => "é".repeat(4000)))
    const byteGroups = new Map<string, number>()
    for (const work of await large.due())
      byteGroups.set(work.batchId!, (byteGroups.get(work.batchId!) ?? 0) + 1)
    expect([...byteGroups.values()].sort((a, b) => a - b)).toEqual([1, 4])
  })

  test("does not group edits, explicit indexing or search", async () => {
    const f = fixture()
    await f.objects.upsert({ properties: { id: "0", name: "First" } })
    await f.objects.upsert({ properties: { id: "1", name: "Second" } })
    expect((await f.due()).every((work) => work.batchId === undefined)).toBe(true)
    await f.objects.byId("0").vector("content").index()
    await f.objects.byId("1").vector("content").index()
    await f.objects.query().vector("content", "search", { k: 1 }).list()
    expect(f.embed.mock.calls.map(([input]) => input.texts.length)).toEqual([1, 1, 1])
  })

  test.each([
    "unknown",
    "oversized",
  ] as const)("falls back to individual calls for %s bounds", async (kind) => {
    const f = fixture({ batching: kind !== "unknown" })
    await f.project(kind === "oversized" ? ["a".repeat(9000), "b".repeat(9000)] : ["Alpha", "Beta"])
    const id = (await f.due())[0]!.batchId!
    await f.process(id)
    expect(f.embed.mock.calls.map(([input]) => input.texts.length)).toEqual([1, 1])
    expect(await f.usage(id)).toMatchObject({ modelCallCount: 2 })
  })

  test("source changes during a call discard only the superseded result", async () => {
    const f = fixture()
    await f.project(["Alpha", "Beta", "Gamma"])
    const id = (await f.due())[0]!.batchId!
    f.embed.mockImplementationOnce(async (input) => {
      await f.objects.upsert({ properties: { id: "0", name: "New source" } })
      return {
        vectors: input.texts.map(() => [1, 0]),
        usage: { inputTokens: 10 },
        reportedCost: { money: { currency: "USD", amountNanos: "100" } },
      }
    })
    await f.process(id)
    expect(f.embed).toHaveBeenCalledTimes(1)
    expect(await f.vectors("0")).toHaveLength(0)
    expect(await f.vectors("1")).toHaveLength(1)
    expect(await f.vectors("2")).toHaveLength(1)
    const [latest] = await f.due()
    expect(latest!.batchId).toBeUndefined()
    expect(latest!.ref.primaryId).toBe("0")
    await f.process(latest!.id)
    expect(await f.vectors("0")).toHaveLength(1)
  })

  test("supersession before admission cannot partially claim or reserve the batch", async () => {
    // Removal proof: remove requireAll from admission; the provider is called for a stale member.
    const f = fixture({
      resolve: async () => {
        await f.objects.upsert({ properties: { id: "0", name: "Changed before admission" } })
        return { ...f.model, resolve: undefined }
      },
    })
    await f.storage.aiLimits.createPolicy({
      id: "budget",
      projectId: f.host.id,
      subject: { type: "project" },
      limit: { meter: "tokens.total", amount: 1000 },
    })
    await f.project(["Alpha", "Beta"])
    const id = (await f.due())[0]!.batchId!
    await expect(f.process(id)).rejects.toBeInstanceOf(VectorIndexingDeferred)
    expect(f.embed).not.toHaveBeenCalled()
    expect(
      (await f.indexing.getBatch({ projectId: f.host.id, batchId: id })).map((work) => work.status)
    ).toEqual(["pending"])
    expect(await f.usage(id)).toMatchObject({ modelCallCount: 0 })
    expect(await f.storage.aiLimits.listPolicyStatuses({ projectId: f.host.id })).toMatchObject([
      { consumption: { reserved: { amount: 0 } } },
    ])
  })

  test("project budget rejection defers the whole batch before inference", async () => {
    const f = fixture()
    await f.storage.aiLimits.createPolicy({
      id: "budget",
      projectId: f.host.id,
      subject: { type: "project" },
      limit: { meter: "tokens.total", amount: 1 },
    })
    await f.project(["Alpha", "Beta"])
    const id = (await f.due())[0]!.batchId!
    await expect(f.process(id)).rejects.toBeInstanceOf(VectorIndexingDeferred)
    expect(f.embed).not.toHaveBeenCalled()
    expect((await f.due()).map((work) => work.status)).toEqual(["pending", "pending"])
    expect((await f.due()).every((work) => Date.parse(work.availableAt) > Date.now())).toBe(true)
  })

  test("ready results resume storage and running work is never re-inferred", async () => {
    const f = fixture()
    await f.project(["Alpha", "Beta"])
    const work = await f.due()
    await f.indexing.updateBatch({
      projectId: f.host.id,
      updates: work.map((entry, i) => ({
        id: entry.id,
        expectedStatus: "pending",
        status: i === 0 ? "ready" : "running",
        values: i === 0 ? [1, 0] : undefined,
        availableAt: new Date().toISOString(),
      })),
    })
    await f.process(work[0]!.batchId!)
    expect(f.embed).not.toHaveBeenCalled()
    expect(await f.vectors(work[0]!.ref.primaryId)).toHaveLength(1)
    expect(await f.indexing.get({ projectId: f.host.id, id: work[1]!.id })).toMatchObject({
      status: "failed",
      error: { code: "vector.outcome_unknown" },
    })
  })

  test("malformed batch responses remain billed once and fail every member without retry", async () => {
    const f = fixture()
    await f.project(["Alpha", "Beta"])
    const id = (await f.due())[0]!.batchId!
    f.embed.mockResolvedValueOnce({
      vectors: [[1, 0]],
      usage: { inputTokens: 10 },
      reportedCost: { money: { currency: "USD", amountNanos: "100" } },
    })
    await f.process(id)
    expect(await f.usage(id)).toMatchObject({ modelCallCount: 1, usage: { inputTokens: 10 } })
    expect(
      (await f.indexing.getBatch({ projectId: f.host.id, batchId: id })).map(
        (work) => work.error?.code
      )
    ).toEqual(["vector.response_invalid", "vector.response_invalid"])
    expect(f.failures).toHaveLength(2)
    await f.process(id)
    expect(f.embed).toHaveBeenCalledTimes(1)
  })

  test("splits durable groups to the provider's lower count and byte bounds", async () => {
    for (const limits of [
      { maxInputs: 2, maxInputBytes: 8192, maxTotalInputBytes: 32768 },
      {
        maxInputs: 32,
        maxInputBytes: 8192,
        maxTotalInputBytes: 2 * Buffer.byteLength(vectorSources(["name"], { name: "Alpha" }).text),
      },
    ]) {
      const f = fixture({ limits })
      await f.project(Array.from({ length: 5 }, () => "Alpha"))
      const id = (await f.due())[0]!.batchId!
      await f.process(id)
      expect(f.embed.mock.calls.map(([input]) => input.texts.length)).toEqual([2, 2, 1])
      expect(await f.usage(id)).toMatchObject({ modelCallCount: 3 })
      expect(await f.due()).toEqual([])
    }
  })

  test("a storage interruption resumes persisted outputs without another paid call", async () => {
    const f = fixture()
    await f.project(["Alpha", "Beta"])
    const id = (await f.due())[0]!.batchId!
    const adapter = getInMemoryOntologyStorageTestingAdapter(f.storage.ontology)
    adapter.setTestHooks({
      beforeWrite(boundary) {
        if (boundary === "finalize") throw new Error("storage unavailable")
      },
    })
    await expect(f.process(id)).rejects.toThrow("storage unavailable")
    expect((await f.due()).map((work) => work.status)).toEqual(["ready", "ready"])
    expect(await f.vectors("0")).toEqual([])
    expect(await f.vectors("1")).toEqual([])
    adapter.setTestHooks({})
    await f.process(id)
    expect(f.embed).toHaveBeenCalledTimes(1)
    expect(await f.vectors("0")).toHaveLength(1)
    expect(await f.vectors("1")).toHaveLength(1)
    expect((await f.vectors("0"))[0]!.lastCommitId).toBe((await f.vectors("1"))[0]!.lastCommitId)
  })

  test("deletion during inference fences the deleted member without losing its peers", async () => {
    const f = fixture()
    await f.project(["Alpha", "Beta"])
    const id = (await f.due())[0]!.batchId!
    f.embed.mockImplementationOnce(async ({ texts }) => {
      await f.objects.byId("0").delete()
      return {
        vectors: texts.map(() => [1, 0]),
        usage: { inputTokens: 10 },
        reportedCost: { money: { currency: "USD", amountNanos: "100" } },
      }
    })
    await f.process(id)
    expect(await f.vectors("0")).toEqual([])
    expect(await f.vectors("1")).toHaveLength(1)
    expect(await f.due()).toEqual([])
  })

  test("a failed storage claim retries delivery without terminalizing pending members", async () => {
    // Removal proof: remove the claiming guard in handleGenerationFailure; pending work becomes failed.
    const f = fixture()
    await f.project(["Alpha", "Beta"])
    const id = (await f.due())[0]!.batchId!
    const update = spyOn(f.indexing, "updateBatch").mockRejectedValueOnce(
      new Error("storage conflict")
    )
    try {
      await expect(f.process(id)).rejects.toThrow("storage conflict")
      expect(f.embed).not.toHaveBeenCalled()
      expect((await f.due()).map((work) => work.status)).toEqual(["pending", "pending"])
    } finally {
      update.mockRestore()
    }
    await f.process(id)
    expect(f.embed).toHaveBeenCalledTimes(1)
    expect(await f.due()).toEqual([])
  })

  test("projection rollback leaves no durable group", async () => {
    const f = fixture()
    getInMemoryOntologyStorageTestingAdapter(f.storage.ontology).setTestHooks({
      beforeWrite(boundary) {
        if (boundary === "finalize") throw new Error("rollback")
      },
    })
    await expect(f.project(["Alpha", "Beta"])).rejects.toThrow("rollback")
    expect(await f.due()).toEqual([])
  })
})

async function readyBatch(f: ReturnType<typeof fixture>) {
  const work = await f.due()
  await f.indexing.updateBatch({
    projectId: f.host.id,
    updates: work.map((entry) => ({
      id: entry.id,
      expectedStatus: "pending",
      status: "ready",
      values: [1, 0],
      availableAt: new Date().toISOString(),
    })),
  })
  const batchId = work[0]!.batchId!
  const scope = createKernelScope({
    projectId: f.host.id,
    operation: { type: "ontology.indexVectors", indexingId: batchId },
    source: { type: "ontologyCommit", commitId: work[0]!.sourceCommitId },
  })
  return { work, batchId, scope }
}

test.each([
  false,
  true,
])("publication rechecks changed objects without inference (source=%s)", async (sourceChanged) => {
  const f = fixture()
  await f.project(["Alpha", "Beta"])
  const { batchId, scope } = await readyBatch(f)
  const commit = f.writer.edits.commit.bind(f.writer.edits)
  let changed = false
  const intercepted = spyOn(f.writer.edits, "commit").mockImplementation(async (command) => {
    if (!changed) {
      changed = true
      await f.objects.upsert({
        properties: sourceChanged
          ? { id: "0", name: "Changed" }
          : { id: "0", name: "Alpha", note: "Unrelated" },
      })
    }
    return commit(command)
  })
  try {
    await storeVectorBatch(f.runtime, f.writer, batchId, scope, new AbortController().signal)
    expect(f.embed).not.toHaveBeenCalled()
    expect(await f.vectors("0")).toHaveLength(sourceChanged ? 0 : 1)
    expect(await f.vectors("1")).toHaveLength(1)
    expect(await f.indexing.getBatch({ projectId: f.host.id, batchId })).toEqual([])
    if (sourceChanged) {
      expect(await f.due()).toMatchObject([{ ref: { primaryId: "0" }, status: "pending" }])
    }
  } finally {
    intercepted.mockRestore()
  }
})

test("a continuously edited member cannot block publication of stable peers", async () => {
  // Removal proof: remove the individual fallback in storeVectorBatch; the stable vector is absent.
  const f = fixture()
  await f.project(["Alpha", "Beta"])
  const { batchId, scope } = await readyBatch(f)
  const commit = f.writer.edits.commit.bind(f.writer.edits)
  let revision = 0
  const intercepted = spyOn(f.writer.edits, "commit").mockImplementation(async (command) => {
    if (
      command.input.mode === "atomic" &&
      command.input.vectorWrites?.some((write) => write.input.ref.primaryId === "0")
    ) {
      await f.objects.upsert({
        properties: { id: "0", name: "Alpha", note: `revision ${++revision}` },
      })
    }
    return commit(command)
  })
  try {
    await expect(
      storeVectorBatch(f.runtime, f.writer, batchId, scope, new AbortController().signal)
    ).rejects.toBeInstanceOf(VectorIndexingDeferred)
    expect(await f.vectors("0")).toEqual([])
    expect(await f.vectors("1")).toHaveLength(1)
    expect(await f.indexing.getBatch({ projectId: f.host.id, batchId })).toMatchObject([
      { ref: { primaryId: "0" }, status: "ready", values: [1, 0] },
    ])
    expect(f.embed).not.toHaveBeenCalled()
  } finally {
    intercepted.mockRestore()
  }
  await storeVectorBatch(f.runtime, f.writer, batchId, scope, new AbortController().signal)
  expect(await f.vectors("0")).toHaveLength(1)
  expect(f.embed).not.toHaveBeenCalled()
})

test("batch authority rejects a foreign member and altered persisted values atomically", async () => {
  const f = fixture()
  await f.project(Array.from({ length: 33 }, (_, i) => `item ${i}`))
  const { work } = await readyBatch(f)
  const groups = new Map<string, VectorIndexingWork[]>()
  for (const entry of work) {
    const group = groups.get(entry.batchId!) ?? []
    group.push(entry)
    groups.set(entry.batchId!, group)
  }
  const members = [...groups.values()].find((entries) => entries.length > 1)!
  const foreign = work.find((entry) => entry.batchId !== members[0]!.batchId)!
  const scope = createKernelScope({
    projectId: f.host.id,
    operation: { type: "ontology.indexVectors", indexingId: members[0]!.batchId! },
    source: { type: "ontologyCommit", commitId: members[0]!.sourceCommitId },
  })
  expect(foreign.sourceCommitId).toBe(members[0]!.sourceCommitId)
  const entries = await Promise.all(
    [...members.slice(0, 2), foreign].map(async (entry) => ({
      input: (await prepare(f.runtime, entry))!,
      values: [1, 0],
    }))
  )
  // Removal proof: authorize against all ready work instead of the batch; the foreign write succeeds.
  await expect(commitPreparedVectors(f.writer, scope, [entries[0]!, entries[2]!])).rejects.toThrow(
    "no longer ready"
  )
  await expect(
    commitPreparedVectors(f.writer, scope, [entries[0]!, { ...entries[1]!, values: [0, 1] }])
  ).rejects.toThrow("only permits its current prepared representation")
  for (const entry of entries) expect(await f.vectors(entry.input.ref.primaryId)).toEqual([])
})
