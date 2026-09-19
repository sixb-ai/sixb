import { expect, test } from "bun:test"
import {
  col,
  type DatasetDefinition,
  type DatasetRow,
  defineDataset,
  defineObjectType,
  defineProjection,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  link,
  type ProjectionDefinition,
  prop,
  SixbHost,
} from "@sixb/core"
import { bindDurablePrimitiveExecution } from "@sixb/core/internal/primitive-execution"
import {
  createProjectionRunId,
  getProjectionRegistry,
  projectionTargetOf,
  shareProjectionRegistry,
} from "@sixb/core/internal/projections"
import { registerOntologyMutationRuntime } from "@sixb/core/internal/runtime"
import type {
  DatasetChanges,
  ReadDatasetChangesInput,
  ReadDatasetRowsInput,
} from "@sixb/core/lake-storage"
import { queueTestProjectionRun } from "@sixb/core/testing"
import { runProjectionJob } from "../src/run-projection-job"

const Device = defineObjectType({
  id: "IncrementalDevice",
  name: "Device",
  properties: [prop("id", "string", { primary: true, required: true }), prop("name", "string")],
  links: [link.self("parent", { cardinality: "one" }), link.self("peers", { cardinality: "many" })],
})
const dataset = defineDataset("incremental_devices", {
  schema: [
    col("id", "string"),
    col("name", "string"),
    col("parent", "string", { nullable: true }),
    col("unused", "string", { nullable: true }),
  ],
})
const projection = defineProjection("incremental_devices", Device)
  .fromDataset(dataset)
  .properties({ id: "id", name: "name" })
  .withLinks({ parent: { link: Device.l.parent, sourceField: "parent", target: Device } })

class InstrumentedLake extends InMemoryLakeStorage {
  fullReads = 0
  deltaReads = 0
  closed = 0
  mode: "complete" | "truncated" | "unsupported" | "failure" = "complete"
  override readRows(input: ReadDatasetRowsInput) {
    this.fullReads++
    return super.readRows(input)
  }
  override async readChanges(input: ReadDatasetChangesInput): Promise<DatasetChanges | null> {
    this.deltaReads++
    if (this.mode === "unsupported") return null
    if (this.mode === "failure") throw new Error("synthetic lake failure")
    const delta = await super.readChanges(input)
    if (!delta) return null
    const complete = this.mode !== "truncated"
    let closed = false
    return {
      ...delta,
      changes: (async function* () {
        let count = 0
        for await (const change of delta.changes) {
          if (!complete && count++ > 0) return
          yield change
        }
      })(),
      close: async () => {
        if (!closed) this.closed++
        closed = true
        await delta.close()
      },
    }
  }
}

function fixture(
  definition: ProjectionDefinition = projection,
  shared?: { readonly lake: InstrumentedLake; readonly storage: InMemoryStorage },
  sourceDataset: DatasetDefinition = dataset
) {
  const lake = shared?.lake ?? new InstrumentedLake()
  const storage = shared?.storage ?? new InMemoryStorage()
  const host = new SixbHost({
    id: "incremental-worker",
    ontology: [Device],
    datasets: [sourceDataset],
    projections: [definition],
    broker: new InMemoryBroker(),
    queues: new InMemoryQueues(),
    blobStorage: new InMemoryBlobStorage(),
    lakeStorage: lake,
    storage,
  })
  let time = Date.parse("2026-01-01T00:00:00.000Z")
  const write = async (rows: readonly DatasetRow[]) => {
    await lake.createDataset(sourceDataset)
    const latest = await lake.getLatestVersion(sourceDataset.id)
    while (latest && Date.now() <= latest.createdAt.getTime()) await Bun.sleep(1)
    const writer = await lake.beginWrite({
      dataset: sourceDataset,
      mode: "snapshot",
      producer: { kind: "sync", id: "synthetic", runId: `write-${time}` },
    })
    await writer.writeRows(rows)
    const version = await writer.commit({ commitMessage: "synthetic changes" })
    time++
    return version
  }
  const run = async (versionId: string, forceFull = false) => {
    const version = await lake.getVersion(sourceDataset.id, versionId)
    if (!version) throw new Error("Missing synthetic version")
    const { datasetId, ...dispatch } = getProjectionRegistry(host).resolveDispatch(definition.id)
    const identity = {
      ...dispatch,
      datasetVersion: { datasetId, versionId, createdAt: version.createdAt.toISOString() },
    }
    if (identity.projectionKind === "telemetry") throw new Error("Unexpected telemetry projection")
    const id = createProjectionRunId(host.id, identity)
    let run = await storage.projectionRuns.getById({ projectId: host.id, id })
    if (!run) {
      const target = projectionTargetOf(definition)
      if (identity.projectionKind === "link" && "sourceObjectTypeId" in target) {
        await queueTestProjectionRun(storage, { projectId: host.id, id, identity, target })
      } else if (identity.projectionKind === "object" && "objectTypeId" in target) {
        await queueTestProjectionRun(storage, { projectId: host.id, id, identity, target })
      } else throw new Error("Unexpected projection target")
      run = await storage.projectionRuns.getById({ projectId: host.id, id })
    }
    const execution = await storage.executions.getById({ projectId: host.id, id: run!.executionId })
    const bound = bindDurablePrimitiveExecution(host, {
      execution: execution!,
      primitive: { kind: "projection", id: definition.id, runId: id },
    })
    const runtime = {
      projectId: host.id,
      ontology: host.definitions.ontology,
      lakeStorage: lake,
      projectionRunsStorage: storage.projectionRuns,
      datasets: host.definitions.datasets,
      projections: host.definitions.projections,
    }
    shareProjectionRegistry(host, runtime)
    registerOntologyMutationRuntime(runtime, {
      ...bound.ontologyMutations,
      ...(forceFull ? { getProjectionSource: undefined } : {}),
    })
    return runProjectionJob({ runtime, job: { id, ...identity } })
  }
  return {
    lake,
    storage,
    host,
    write,
    run,
    active: () =>
      storage.ontology.sources.getActive({
        projectId: host.id,
        source: { projectionId: definition.id },
      }),
    object: (primaryId: string) =>
      storage.objects.getByPrimaryId({ projectId: host.id, objectTypeId: Device.id, primaryId }),
  }
}

// Red proof: return null from prepareIncrementalReplacement; root counts and read counters fail.
test("automatically stages only complete changed roots and reuses unchanged provenance", async () => {
  const f = fixture()
  const a = { id: "a", name: "A" }
  const b = { id: "b", name: "B", parent: "a" }
  await f.run((await f.write([a, b])).versionId)
  const original = await f.object("a")
  const v2 = await f.write([a, { ...b, name: "B2" }])
  const result = await f.run(v2.versionId)
  expect(result.run.progress).toEqual({
    sourceRowsRead: 0,
    sourceRowsSkipped: 0,
    sourceChangesRead: 1,
  })
  expect(await f.active()).toMatchObject({
    rootCount: 1,
    assertionCount: 2,
    base: expect.any(Object),
  })
  expect(await f.object("a")).toEqual(original)
  const v3 = await f.write([
    { ...a, unused: "irrelevant" },
    { ...b, name: "B2" },
  ])
  await f.run(v3.versionId)
  expect(await f.active()).toMatchObject({ rootCount: 0, assertionCount: 0 })
  expect(await f.object("b")).toMatchObject({ properties: { name: "B2" } })
  expect(f.lake.fullReads).toBe(1)
  expect(f.lake.closed).toBe(2)
  await f.run(v3.versionId)
  expect(f.lake.deltaReads).toBe(2)
})

test("handles removals, new identities, FK removal and an empty final source", async () => {
  const f = fixture()
  await f.run(
    (
      await f.write([
        { id: "a", name: "A" },
        { id: "b", name: "B", parent: "a" },
      ])
    ).versionId
  )
  await f.run(
    (
      await f.write([
        { id: "c", name: "C" },
        { id: "b", name: "B", parent: null },
      ])
    ).versionId
  )
  expect(await f.object("a")).toBeNull()
  expect(await f.object("c")).not.toBeNull()
  expect(await f.active()).toMatchObject({ rootCount: 3 })
  await f.run((await f.write([])).versionId)
  expect(await f.object("b")).toBeNull()
  expect(await f.object("c")).toBeNull()
})

test("rejects an incomplete delta without publishing and retries with a full fallback", async () => {
  const f = fixture()
  const initial = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
    { id: "c", name: "C" },
  ]
  await f.run((await f.write(initial)).versionId)
  const head = await f.active()
  const version = await f.write([])
  f.lake.mode = "truncated"
  await expect(f.run(version.versionId)).rejects.toThrow("EOF after 1 of 3")
  expect(await f.active()).toEqual(head)
  expect(await f.object("a")).not.toBeNull()
  expect(f.lake.closed).toBe(1)
  f.lake.mode = "unsupported"
  const result = await f.run(version.versionId)
  expect(result.run.status).toBe("succeeded")
  expect(result.run.attempt).toBe(2)
  expect(await f.object("a")).toBeNull()
})

test("does not mask operational change-reader failures as a full replacement", async () => {
  const f = fixture()
  await f.run((await f.write([{ id: "a", name: "A" }])).versionId)
  const version = await f.write([{ id: "a", name: "B" }])
  f.lake.mode = "failure"
  await expect(f.run(version.versionId)).rejects.toThrow("synthetic lake failure")
  expect(f.lake.fullReads).toBe(1)
  f.lake.mode = "complete"
  await f.run(version.versionId)
  expect(await f.object("a")).toMatchObject({ properties: { name: "B" } })
})

test("duplicate target identities take the full validation path and preserve the source", async () => {
  const f = fixture()
  await f.run((await f.write([{ id: "a", name: "A" }])).versionId)
  const head = await f.active()
  const version = await f.write([
    { id: "a", name: "B" },
    { id: "a", name: "C" },
  ])
  await expect(f.run(version.versionId)).rejects.toThrow("repeats root")
  expect(f.lake.fullReads).toBe(2)
  expect(await f.active()).toEqual(head)
})

test("a link projection replaces only changed edge roots and keeps unchanged edges", async () => {
  const definition = defineProjection("incremental_peers", Device.l.peers)
    .fromDataset(dataset)
    .sourceField("id")
    .targetField("name")
  const f = fixture(definition)
  const { createTestSixb } = await import("@sixb/core/testing")
  for (const id of ["a", "b", "c"]) {
    await createTestSixb(f.host)
      .objects(Device)
      .upsert({ properties: { id, name: id } })
  }
  await f.run(
    (
      await f.write([
        { id: "a", name: "b" },
        { id: "b", name: "c" },
      ])
    ).versionId
  )
  await f.run(
    (
      await f.write([
        { id: "a", name: "c" },
        { id: "b", name: "c" },
      ])
    ).versionId
  )
  expect(await f.active()).toMatchObject({ rootCount: 2, assertionCount: 1 })
  const links = await f.storage.objects.listLinks({
    projectId: f.host.id,
    objectTypeId: Device.id,
    objectId: "b",
    linkId: "peers",
  })
  expect(links.map((row) => row.targetId)).toEqual(["c"])
  const changed = await f.storage.objects.listLinks({
    projectId: f.host.id,
    objectTypeId: Device.id,
    objectId: "a",
    linkId: "peers",
  })
  expect(changed.map((row) => row.targetId)).toEqual(["c"])
  expect(f.lake.fullReads).toBe(1)
})

test("creating a missing target resolves a link retained from an older source version", async () => {
  const f = fixture()
  const a = { id: "a", name: "A", parent: "b" }
  await f.run((await f.write([a])).versionId)
  await f.run((await f.write([a, { id: "b", name: "B" }])).versionId)
  expect(await f.active()).toMatchObject({ rootCount: 1, assertionCount: 1 })
  const links = await f.storage.objects.listLinks({
    projectId: f.host.id,
    objectTypeId: Device.id,
    objectId: "a",
    linkId: "parent",
  })
  expect(links.map((row) => row.targetId)).toEqual(["b"])
})

test("incremental and complete runs converge across mixed edits, deletions and dangling links", async () => {
  const incremental = fixture()
  const complete = fixture()
  let seed = 17
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed
  }
  let rows: DatasetRow[] = Array.from({ length: 30 }, (_, i) => ({
    id: String(i),
    name: `value-${i}`,
    parent: String((i + 1) % 35),
  }))
  const snapshot = async (f: ReturnType<typeof fixture>) =>
    Promise.all(
      Array.from({ length: 35 }, async (_, i) => {
        const object = await f.object(String(i))
        const links = await f.storage.objects.listLinks({
          projectId: f.host.id,
          objectTypeId: Device.id,
          objectId: String(i),
          linkId: "parent",
        })
        return {
          id: String(i),
          properties: object?.properties ?? null,
          targets: links.map((row) => row.targetId).sort(),
        }
      })
    )
  try {
    for (let round = 0; round < 12; round++) {
      if (round > 0) {
        const next = new Map(rows.map((row) => [row.id, row]))
        for (let change = 0; change < 5; change++) {
          const id = String(random() % 35)
          if (random() % 4 === 0) next.delete(id)
          else
            next.set(id, {
              id,
              name: `value-${round}`,
              parent: random() % 3 === 0 ? null : String(random() % 35),
            })
        }
        rows = [...next.values()].reverse()
      }
      // Intermediate versions deliberately remain unprojected.
      if (round % 3 === 1) await incremental.write([{ id: "skipped", name: "temporary" }])
      await incremental.run((await incremental.write(rows)).versionId)
      await complete.run((await complete.write(rows)).versionId, true)
      expect(await snapshot(incremental)).toEqual(await snapshot(complete))
      await incremental.storage.ontology.sources.cleanupTerminal({
        projectId: incremental.host.id,
        terminalBefore: "2100-01-01T00:00:00.000Z",
        limit: 1_000,
      })
    }
    expect(incremental.lake.fullReads).toBe(1)
    expect(incremental.lake.deltaReads).toBe(11)
    expect(complete.lake.fullReads).toBe(12)
  } finally {
    await incremental.host.closeBroker()
    await complete.host.closeBroker()
  }
})

test("a changed mapping rebuilds every root even at the same dataset version", async () => {
  const original = fixture()
  const version = await original.write([
    { id: "a", name: "Original A", unused: "New A" },
    { id: "b", name: "Original B", unused: "New B" },
  ])
  await original.run(version.versionId)
  const changed = fixture(
    defineProjection(projection.id, Device)
      .fromDataset(dataset)
      .properties({ id: "id", name: "unused" }),
    original
  )
  try {
    await changed.run(version.versionId)
    expect(await changed.object("a")).toMatchObject({ properties: { name: "New A" } })
    expect(await changed.object("b")).toMatchObject({ properties: { name: "New B" } })
    expect(changed.lake.fullReads).toBe(2)
    expect(changed.lake.deltaReads).toBe(0)
    expect(await changed.active()).toMatchObject({ rootCount: 2, assertionCount: 2 })
  } finally {
    await original.host.closeBroker()
    await changed.host.closeBroker()
  }
})

// Red proof: omit updated_at from incremental comparison columns; the action remains the winner.
test("a timestamp-only delta re-evaluates mostRecent against a runtime edit", async () => {
  const timedDataset = defineDataset(dataset.id, {
    schema: [col("id", "string"), col("name", "string"), col("updated_at", "timestamp")],
  })
  const definition = defineProjection(projection.id, Device)
    .fromDataset(timedDataset)
    .properties({ id: "id", name: "name" })
    .resolveConflicts({ strategy: "mostRecent", sourceTimestamp: "updated_at" })
  const f = fixture(definition, undefined, timedDataset)
  const { createTestSixb } = await import("@sixb/core/testing")
  try {
    await f.run(
      (await f.write([{ id: "a", name: "Source", updated_at: "2020-01-01T00:00:00.000Z" }]))
        .versionId
    )
    await createTestSixb(f.host)
      .objects(Device)
      .upsert({ properties: { id: "a", name: "Action" } })
    expect(await f.object("a")).toMatchObject({ properties: { name: "Action" } })
    await f.run(
      (await f.write([{ id: "a", name: "Source", updated_at: "2100-01-01T00:00:00.000Z" }]))
        .versionId
    )
    expect(await f.object("a")).toMatchObject({ properties: { name: "Source" } })
    expect(await f.active()).toMatchObject({ rootCount: 1, base: expect.any(Object) })
    expect(f.lake.fullReads).toBe(1)
  } finally {
    await f.host.closeBroker()
  }
})
