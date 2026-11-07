import { afterEach, expect, jest, test } from "bun:test"
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
import type { LakeQueueJob, NewQueueJob } from "../src/queues"

const dataset = defineDataset("source.people", {
  schema: [col("id", "string"), col("revision", "int64"), col("name", "string")],
  primaryKey: "id",
  sequenceBy: "revision",
})

afterEach(() => {
  jest.useRealTimers()
})

async function turns(count = 20): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

function setup() {
  const lakeStorage = new InMemoryLakeStorage()
  const storage = new InMemoryStorage()
  const broker = new InMemoryBroker()
  const queues = new InMemoryQueues()
  const failures: Error[] = []

  const enqueued: NewQueueJob<LakeQueueJob>[] = []
  const enqueue = queues.lake.enqueue.bind(queues.lake)
  queues.lake.enqueue = async (input) => {
    enqueued.push(...input.jobs)
    return enqueue(input)
  }

  const host = new SixbHost({
    id: "ingest-test",
    ontology: [],
    datasets: [dataset],
    lakeStorage,
    broker,
    storage,
    queues,
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
    queues,
    enqueued,
    failures,
    waiting,
    sixb: host.withScope(createTestingScope({ projectId: host.id })),
  }
}

test("ingestion stores validated changes for a flush, and one request covers the deliveries after it", async () => {
  // Regression proof: queue the flush whatever `append` answers in `ingest`; the second delivery
  // then asks twice, and a burst costs a queue write per delivery.
  const { host, lakeStorage, sixb, waiting, enqueued } = setup()

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

  expect(enqueued).toEqual([
    {
      id: `ingest-flush:${dataset.id}:0`,
      type: "dataset.ingest.flush.requested",
      payload: { datasetId: dataset.id },
      metadata: { source: "ingest", correlationId: sixb.execution.correlationId },
    },
  ])
  // Ingestion publishes nothing: no process has to hear about it for a flush to run.
  expect(await host.events.read()).toEqual([])
})

test("a burst of deliveries queues one flush", async () => {
  // Regression proof: drop the `requested` check in `requestFlushIn`; every delivery then asks.
  const { sixb, enqueued } = setup()

  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      sixb.datasets.ingest(dataset, {
        changes: [change.upsert({ id: `${index}`, revision: 1, name: "Sam" })],
      })
    )
  )

  expect(enqueued.map((job) => job.id)).toEqual([`ingest-flush:${dataset.id}:0`])
})

test("a queue that refuses the flush fails nothing: the changes are stored", async () => {
  // Regression proof: call `enqueueIngestFlush` from `ingest`; the call then rejects, and the
  // webhook source sends again what is already stored.
  const { sixb, queues, waiting } = setup()
  queues.lake.enqueue = async () => {
    throw new Error("queue offline")
  }

  const warn = console.warn
  console.warn = () => {}
  try {
    const result = await sixb.datasets.ingest(dataset, {
      changes: [change.upsert({ id: "42", revision: 8, name: "Sam" })],
    })

    expect(result.changes).toBe(1)
  } finally {
    console.warn = warn
  }

  expect(await waiting()).toMatchObject([{ datasetId: dataset.id, pendingDeliveries: 1 }])
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

test("a queue that never answers holds the call for a second at most", async () => {
  // Regression proof: await the enqueue without its bound in `tryEnqueueIngestFlush`; the call then
  // never returns. A queue whose Redis is down at start behaves this way.
  jest.useFakeTimers()
  const { sixb, queues, waiting } = setup()
  queues.lake.enqueue = () => new Promise(() => {})

  const warn = console.warn
  console.warn = () => {}
  try {
    let returned = false
    const ingesting = sixb.datasets
      .ingest(dataset, { changes: [change.upsert({ id: "42", revision: 8, name: "Sam" })] })
      .then(() => {
        returned = true
      })

    await turns()
    jest.advanceTimersByTime(999)
    await turns()
    expect(returned).toBe(false)

    jest.advanceTimersByTime(1)
    await ingesting
  } finally {
    console.warn = warn
  }

  expect(await waiting()).toMatchObject([{ datasetId: dataset.id, pendingDeliveries: 1 }])
})

test("a later delivery asks again for a flush the queue lost, after half a minute", async () => {
  // Regression proof: join any open request in `requestFlushIn`; the request then stays open with
  // no job, and only the orchestrator's pass can restart ingestion.
  jest.useFakeTimers()
  const { sixb, enqueued } = setup()
  const ingest = (id: string) =>
    sixb.datasets.ingest(dataset, {
      changes: [change.upsert({ id, revision: 1, name: "Sam" })],
    })

  await ingest("1")

  jest.advanceTimersByTime(29_999)
  await ingest("2")
  expect(enqueued).toHaveLength(1)

  jest.advanceTimersByTime(1)
  await ingest("3")
  await ingest("4")

  expect(enqueued.map((job) => job.id)).toEqual([
    `ingest-flush:${dataset.id}:0`,
    `ingest-flush:${dataset.id}:0`,
  ])
})

test("ingestion needs no broker", async () => {
  // Regression proof: announce the request on the event log in `ingest`; the outage is then
  // reported, and a flush waits for whoever had to hear it.
  const { host, broker, enqueued, failures, sixb, waiting } = setup()
  broker.append = async () => {
    throw new Error("broker offline")
  }

  const result = await sixb.datasets.ingest(dataset, {
    changes: [change.upsert({ id: "42", revision: 1, name: "Sam" })],
  })

  expect(result.changes).toBe(1)
  expect(enqueued).toHaveLength(1)
  expect(await waiting()).toMatchObject([{ datasetId: dataset.id, pendingDeliveries: 1 }])

  await flushSixbErrors(host)
  expect(failures).toEqual([])
})
