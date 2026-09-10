import { expect, test } from "bun:test"
import {
  change,
  col,
  defineDataset,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "../src"
import { emptyGrantIndex } from "../src/authorization"
import { flushSixbErrors } from "../src/error-reporting/capability"
import { createPrincipalRequestScope, createTestingScope } from "../src/execution/scopes"

const dataset = defineDataset("source.people", {
  schema: [col("id", "string"), col("revision", "int64"), col("name", "string")],
  primaryKey: "id",
  sequenceBy: "revision",
})

function setup() {
  const lakeStorage = new InMemoryLakeStorage()
  const broker = new InMemoryBroker()
  const failures: Error[] = []
  const host = new SixbHost({
    id: "ingest-test",
    ontology: [],
    datasets: [dataset],
    lakeStorage,
    broker,
    storage: new InMemoryStorage(),
    queues: new InMemoryQueues(),
    blobStorage: new InMemoryBlobStorage(),
    onError: (error) => {
      failures.push(error)
    },
  })
  return {
    host,
    lakeStorage,
    broker,
    failures,
    sixb: host.withScope(createTestingScope({ projectId: host.id })),
  }
}

test("ingestion validates and orders source changes and only notifies for new versions", async () => {
  // Regression proof: remove the facade's event emission; the dataset event assertions fail.
  const { host, lakeStorage, sixb } = setup()
  const first = await sixb.datasets.ingest(dataset, {
    changes: [change.upsert({ id: "42", revision: 8, name: "Sam" })],
  })
  expect(first).toMatchObject({
    outcome: "created",
    rowsRead: 1,
    version: { mode: "merge", producer: { kind: "ingest", id: sixb.execution.id } },
  })
  expect(
    await sixb.datasets.ingest(dataset, {
      changes: [change.upsert({ id: "42", revision: 7, name: "Old" })],
    })
  ).toMatchObject({ outcome: "unchanged", version: first.version })
  await expect(
    sixb.datasets.ingest(dataset, {
      changes: [
        change.upsert({ id: "new", revision: 1, name: "Partial" }),
        change.upsert({ id: "42", revision: 8, name: "Conflict" }),
      ],
    })
  ).rejects.toThrow("conflicting content")
  expect(await lakeStorage.getLatestVersion(dataset.id)).toEqual(first.version)
  const events = await host.events.read()
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({
    type: "dataset.version.committed",
    correlationId: sixb.execution.correlationId,
    payload: {
      datasetId: dataset.id,
      versionId: first.version?.versionId,
      producer: first.version?.producer,
    },
  })
  expect(
    await sixb.datasets.ingest(dataset, { changes: [change.delete({ id: "42" }, { sequence: 9 })] })
  ).toMatchObject({ outcome: "created", version: { rowCount: 0 } })
})

test("ingestion checks authority and registration before consuming input or creating a dataset", async () => {
  // Regression proof: remove assertPrivileged from ingestion; the scoped reader writes successfully.
  const { host, lakeStorage, sixb } = setup()
  let consumed = false
  function* changes() {
    consumed = true
    yield change.upsert({ id: "42", revision: 1, name: "Sam" })
  }
  const scoped = host.withScope(
    createPrincipalRequestScope({
      projectId: host.id,
      requestId: "request",
      correlationId: "request",
      context: {
        principal: { type: "user", id: "reader" },
        groupIds: [],
        roleIds: [],
        grants: { ...emptyGrantIndex(), "view:dataset": new Set([dataset.id]) },
      },
    })
  )
  expect(scoped.datasets.getById(dataset.id)?.id).toBe(dataset.id)
  await expect(scoped.datasets.ingest(dataset, { changes: changes() })).rejects.toThrow(
    "not covered by scoped authorization grants"
  )
  await expect(
    sixb.datasets.ingest({ ...dataset, id: "unregistered" }, { changes: changes() })
  ).rejects.toThrow("not registered")
  expect(consumed).toBe(false)
  expect(await lakeStorage.listDatasets()).toEqual([])
})

test("ingestion uses the registered schema and cancels one-shot input atomically", async () => {
  const { lakeStorage, sixb } = setup()
  await expect(
    sixb.datasets.ingest(
      { ...dataset, schema: { columns: [col("id", "string")] } },
      { changes: [change.upsert({ id: "42" })] }
    )
  ).rejects.toThrow()
  const controller = new AbortController()
  await expect(
    sixb.datasets.ingest(dataset, {
      signal: controller.signal,
      changes: (async function* () {
        yield change.upsert({ id: "42", revision: 1, name: "Sam" })
        controller.abort(new Error("cancelled ingestion"))
      })(),
    })
  ).rejects.toThrow("cancelled ingestion")
  expect(await lakeStorage.getLatestVersion(dataset.id)).toBeNull()
})

test("ingestion rejects unkeyed datasets and unsupported providers before mutation", async () => {
  const unkeyed = defineDataset("unkeyed", { schema: [col("id", "string")] })
  const lakeStorage = new InMemoryLakeStorage()
  const host = new SixbHost({
    id: "ingest-preflight",
    ontology: [],
    datasets: [dataset, unkeyed],
    lakeStorage,
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    queues: new InMemoryQueues(),
    blobStorage: new InMemoryBlobStorage(),
  })
  const sixb = host.withScope(createTestingScope({ projectId: host.id }))
  await expect(sixb.datasets.ingest(unkeyed, { changes: [] })).rejects.toThrow("primaryKey")
  Object.defineProperty(lakeStorage, "beginMerge", { value: undefined })
  await expect(sixb.datasets.ingest(dataset, { changes: [] })).rejects.toThrow("merge support")
  expect(await lakeStorage.listDatasets()).toEqual([])
})

test("notification failure is reported after commit without failing ingestion", async () => {
  const { host, broker, failures, lakeStorage, sixb } = setup()
  broker.append = async () => {
    throw new Error("broker offline")
  }
  const result = await sixb.datasets.ingest(dataset, {
    changes: [change.upsert({ id: "42", revision: 1, name: "Sam" })],
  })
  expect(result.outcome).toBe("created")
  expect(await lakeStorage.getLatestVersion(dataset.id)).toEqual(result.version)
  await flushSixbErrors(host)
  expect(failures).toHaveLength(1)
})
