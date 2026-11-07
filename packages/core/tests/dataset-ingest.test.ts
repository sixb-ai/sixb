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
  const storage = new InMemoryStorage()
  const broker = new InMemoryBroker()
  const failures: Error[] = []
  const host = new SixbHost({
    id: "ingest-test",
    ontology: [],
    datasets: [dataset],
    lakeStorage,
    broker,
    storage,
    queues: new InMemoryQueues(),
    blobStorage: new InMemoryBlobStorage(),
    onError: (error) => {
      failures.push(error)
    },
  })
  const waiting = () => storage.datasetIngest.summarize({ projectId: host.id })

  return {
    host,
    lakeStorage,
    storage,
    broker,
    failures,
    waiting,
    sixb: host.withScope(createTestingScope({ projectId: host.id })),
  }
}

test("ingestion stores validated changes for a flush, and one request covers the deliveries after it", async () => {
  // Regression proof: emit `dataset.ingest.queued` whatever `requestFlush` answers; the second
  // delivery then queues a second request.
  const { host, lakeStorage, sixb, waiting } = setup()

  const first = await sixb.datasets.ingest(dataset, {
    changes: [
      change.upsert({ id: "42", revision: 8, name: "Sam" }),
      change.delete({ id: "9" }, { sequence: 3 }),
    ],
  })
  const second = await sixb.datasets.ingest(dataset, {
    changes: [change.upsert({ id: "43", revision: 1, name: "Ada" })],
  })

  expect(first).toEqual({ deliveryId: expect.any(String), changes: 2 })
  expect(second).toEqual({ deliveryId: expect.any(String), changes: 1 })
  expect(second.deliveryId).not.toBe(first.deliveryId)

  // Nothing is in the lake until a flush writes it.
  expect(await lakeStorage.getLatestVersion(dataset.id)).toBeNull()
  expect(await waiting()).toMatchObject([
    { datasetId: dataset.id, pendingDeliveries: 2, pendingChanges: 3 },
  ])

  const queued = await host.events.read()
  expect(queued).toHaveLength(1)
  expect(queued[0]).toMatchObject({
    type: "dataset.ingest.queued",
    correlationId: sixb.execution.correlationId,
    payload: { datasetId: dataset.id, request: 0 },
  })
})

test("an ingestion without changes stores and requests nothing", async () => {
  const { host, sixb, waiting } = setup()

  expect(await sixb.datasets.ingest(dataset, { changes: [] })).toEqual({
    deliveryId: null,
    changes: 0,
  })
  expect(await waiting()).toEqual([])
  expect(await host.events.read()).toEqual([])
})

test("ingestion checks authority and registration before consuming input", async () => {
  // Regression proof: remove assertPrivileged from ingestion; the scoped reader stores changes.
  const { host, sixb, waiting } = setup()
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

  const denied = await scoped.datasets
    .ingest(dataset, { changes: changes() })
    .catch((error) => error)
  expect(String(denied)).toContain("not covered by scoped authorization grants")

  const unregistered = await sixb.datasets
    .ingest({ ...dataset, id: "unregistered" }, { changes: changes() })
    .catch((error) => error)
  expect(String(unregistered)).toContain("not registered")

  expect(consumed).toBe(false)
  expect(await waiting()).toEqual([])
})

test("ingestion validates against the registered schema and stores nothing when cancelled", async () => {
  // Regression proof: drop the abort check after the last change in validateDatasetMergeChanges;
  // the cancelled call stores its change.
  const { host, sixb, waiting } = setup()

  // Valid for the caller's copy, which drops `name`; the registered schema requires it.
  const invalid = await sixb.datasets
    .ingest(
      { ...dataset, schema: { columns: [col("id", "string"), col("revision", "int64")] } },
      { changes: [change.upsert({ id: "42", revision: 1 })] }
    )
    .catch((error) => error)
  expect(String(invalid)).toContain("missing required column 'name'")

  const controller = new AbortController()
  const cancelled = await sixb.datasets
    .ingest(dataset, {
      signal: controller.signal,
      changes: (async function* () {
        yield change.upsert({ id: "42", revision: 1, name: "Sam" })
        controller.abort(new Error("cancelled ingestion"))
      })(),
    })
    .catch((error) => error)
  expect(String(cancelled)).toContain("cancelled ingestion")

  expect(await waiting()).toEqual([])
  expect(await host.events.read()).toEqual([])
})

test("ingestion refuses unkeyed datasets and unsupported providers before storing", async () => {
  const unkeyed = defineDataset("unkeyed", { schema: [col("id", "string")] })
  const lakeStorage = new InMemoryLakeStorage()
  const storage = new InMemoryStorage()
  const host = new SixbHost({
    id: "ingest-preflight",
    ontology: [],
    datasets: [dataset, unkeyed],
    lakeStorage,
    broker: new InMemoryBroker(),
    storage,
    queues: new InMemoryQueues(),
    blobStorage: new InMemoryBlobStorage(),
  })
  const sixb = host.withScope(createTestingScope({ projectId: host.id }))
  const refused = (input: Parameters<typeof sixb.datasets.ingest>[0]) =>
    sixb.datasets.ingest(input, { changes: [] }).catch((error) => String(error))

  expect(await refused(unkeyed)).toContain("primaryKey")

  Object.defineProperty(storage, "datasetIngest", { value: undefined })
  expect(await refused(dataset)).toContain("dataset ingest inbox")

  Object.defineProperty(lakeStorage, "beginMerge", { value: undefined })
  expect(await refused(dataset)).toContain("merge support")
})

test("a request the broker loses is reported, and the changes stay stored", async () => {
  const { host, broker, failures, sixb, waiting } = setup()
  broker.append = async () => {
    throw new Error("broker offline")
  }

  const result = await sixb.datasets.ingest(dataset, {
    changes: [change.upsert({ id: "42", revision: 1, name: "Sam" })],
  })

  expect(result.changes).toBe(1)
  expect(await waiting()).toMatchObject([{ datasetId: dataset.id, pendingDeliveries: 1 }])

  await flushSixbErrors(host)
  expect(failures).toHaveLength(1)
})
