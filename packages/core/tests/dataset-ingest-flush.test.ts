import { afterEach, expect, jest, test } from "bun:test"
import {
  change,
  col,
  type DatasetDefinition,
  type DatasetRow,
  defineDataset,
  events,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type MergeChange,
  type SixbErrorContext,
  SixbHost,
} from "../src"
import { writeDataset } from "../src/datasets/write"
import { flushSixbErrors } from "../src/error-reporting/capability"
import { buildEventSelectorPredicate } from "../src/events"
import { createTestingScope } from "../src/execution/scopes"
import { LakeStorageError, LakeValueRefusedError } from "../src/lake-storage/errors"
import { DatasetIngestFlushError, getDatasetIngestRuntime } from "../src/runtime/internal"
import { InMemoryDatasetIngestStorage } from "../src/storage"

const people = defineDataset("source.people", {
  schema: [col("id", "string"), col("revision", "int64"), col("name", "string")],
  primaryKey: "id",
  sequenceBy: "revision",
})

const contacts = defineDataset("source.contacts", {
  schema: [col("id", "string"), col("name", "string")],
  primaryKey: "id",
})

const documents = defineDataset("source.documents", {
  schema: [col("id", "string"), col("file", "fileRef")],
  primaryKey: "id",
})

afterEach(() => {
  jest.useRealTimers()
})

/**
 * A lake that cannot hold some values core validation accepts, as DuckLake's DECIMAL(38,9) refuses
 * a decimal with ten fractional digits: it refuses a name for which `refuses` is true, as it stages.
 */
class RefusingLakeStorage extends InMemoryLakeStorage {
  constructor(
    private readonly refuses: (name: unknown) => boolean,
    private readonly refusal: (message: string, changeIndex: number) => Error = (
      message,
      changeIndex
    ) => new LakeValueRefusedError(message, { changeIndex })
  ) {
    super()
  }

  override async beginMerge(input: Parameters<InMemoryLakeStorage["beginMerge"]>[0]) {
    const session = await super.beginMerge(input)
    const writeChanges = session.writeChanges.bind(session)
    const refuses = this.refuses
    const refusal = this.refusal

    session.writeChanges = async (changes) => {
      const accepted: MergeChange<DatasetRow, DatasetRow>[] = []
      for await (const change of changes) {
        if (change.kind === "upsert" && refuses(change.row.name)) {
          throw refusal(
            `[TestLake] Column 'name' cannot hold '${String(change.row.name)}' exactly.`,
            accepted.length
          )
        }
        accepted.push(change)
      }
      await writeChanges(accepted)
    }

    return session
  }
}

function setup(lakeStorage = new InMemoryLakeStorage()) {
  const storage = new InMemoryStorage()
  // The inbox alone, outside the storage's operation lock: a test can pause one of its calls
  // without holding every other storage call behind it.
  Object.defineProperty(storage, "datasetIngest", { value: new InMemoryDatasetIngestStorage() })
  const blobStorage = new InMemoryBlobStorage()
  const broker = new InMemoryBroker()
  const queues = new InMemoryQueues()
  const reports: SixbErrorContext[] = []
  const host = new SixbHost({
    id: "ingest-flush-test",
    ontology: [],
    datasets: [people, contacts, documents],
    lakeStorage,
    broker,
    storage,
    queues,
    blobStorage,
    onError: (_error, context) => {
      reports.push(context)
    },
  })

  const scope = () => host.withScope(createTestingScope({ projectId: host.id }))
  const sixb = scope()
  const flush = (dataset: DatasetDefinition = people) =>
    getDatasetIngestRuntime(host).flush(dataset.id, new AbortController().signal)
  const ingest = (dataset: DatasetDefinition, ...changes: MergeChange<DatasetRow, DatasetRow>[]) =>
    sixb.datasets.ingest(dataset, { changes })
  const committed = async () =>
    (await host.events.read()).filter((event) => event.type === "dataset.version.committed")
  const rows = async (dataset: DatasetDefinition = people) => {
    const read = await sixb.datasets.readRows(dataset)
    const all: DatasetRow[] = []
    for await (const row of read?.rows ?? []) all.push(row)
    return all.sort((left, right) => String(left.id).localeCompare(String(right.id)))
  }
  const reported = async () => {
    await flushSixbErrors(host)
    return reports
  }

  return {
    host,
    storage,
    queues,
    lakeStorage,
    blobStorage,
    broker,
    sixb,
    scope,
    flush,
    ingest,
    committed,
    rows,
    reported,
  }
}

test("a flush writes every waiting delivery as one version, in delivery order", async () => {
  // Regression proof: read the batch's deliveries newest first in `values`; without a source
  // sequence, "1" then ends on the first delivery's value.
  const { host, lakeStorage, scope, flush, committed, rows, storage } = setup()
  const first = scope()
  const second = scope()

  await first.datasets.ingest(contacts, {
    changes: [change.upsert({ id: "1", name: "Sam" }), change.upsert({ id: "7", name: "Gone" })],
  })
  await second.datasets.ingest(contacts, {
    changes: [
      change.upsert({ id: "1", name: "Samuel" }),
      change.upsert({ id: "2", name: "Ada" }),
      change.delete({ id: "7" }),
    ],
  })

  expect(await flush(contacts)).toEqual({ kind: "flushed", versions: 1, deliveries: 2 })

  const versions = await lakeStorage.listVersions(contacts.id)
  expect(versions).toHaveLength(1)
  expect(versions[0]?.producer).toEqual({
    kind: "ingest",
    id: first.execution.id,
    runId: expect.stringMatching(/^flush_/),
  })
  expect((await rows(contacts)).map((row) => row.name)).toEqual(["Samuel", "Ada"])

  expect(await committed()).toMatchObject([
    {
      correlationId: first.execution.correlationId,
      payload: { datasetId: contacts.id, versionId: versions[0]?.versionId, rowsChanged: true },
    },
  ])
  expect(await storage.datasetIngest.summarize({ projectId: host.id })).toEqual([])

  // An empty inbox writes nothing.
  expect(await flush(contacts)).toEqual({ kind: "flushed", versions: 0, deliveries: 0 })
  expect(await lakeStorage.listVersions(contacts.id)).toHaveLength(1)
})

test("one flush gives the rows the deliveries give applied one by one", async () => {
  // Regression proof: in `values`, yield each delivery's changes in reverse; the rows differ.
  for (const dataset of [people, contacts]) {
    const oneByOne = new InMemoryLakeStorage()
    const { ingest, flush, rows } = setup()

    for (const delivery of scriptedDeliveries(dataset)) {
      await ingest(dataset, ...delivery)
      await writeDataset({
        lakeStorage: oneByOne,
        blobStorage: new InMemoryBlobStorage(),
        dataset,
        mode: "merge",
        signal: new AbortController().signal,
        readValues: async () => delivery.map((value) => ({ value })),
      })
    }

    await flush(dataset)

    const expected =
      (await oneByOne.listVersions(dataset.id)).length > 0 ? await readAll(oneByOne, dataset) : []
    expect(await rows(dataset)).toEqual(expected)
  }
})

test("a version says whether the flush changed rows or lineage", async () => {
  // Red check: emit `rowsChanged: true` instead of the created version's flag.
  const { ingest, flush, committed } = setup()
  const updated = buildEventSelectorPredicate(events.dataset(people).updated())

  await ingest(people, change.upsert({ id: "42", revision: 8, name: "Sam" }))
  await flush()

  // The delete of a person the dataset never held only advances source ordering.
  await ingest(people, change.delete({ id: "7" }, { sequence: 3 }))
  await flush()

  // A row that only carries a newer sequence triggers no dataset update.
  await ingest(people, change.upsert({ id: "42", revision: 9, name: "Sam" }))
  await flush()

  const announced = await committed()
  expect(
    announced.map((event) => [event.payload.rowsChanged, event.payload.lineageChanged])
  ).toEqual([
    [true, true],
    [false, false],
    [false, false],
  ])
  expect(announced.map(updated)).toEqual([true, false, false])
})

test("a delivery the lake refuses is reported with what to send again, and the rest commits", async () => {
  // Regression proof: return null from `findConflicting`; the flush fails and commits nothing.
  const { scope, ingest, flush, rows, reported } = setup()
  await ingest(people, change.upsert({ id: "42", revision: 8, name: "Sam" }))
  await flush()

  const kept = scope()
  const refusedByLake = scope()
  const refusedByBatch = scope()
  await kept.datasets.ingest(people, {
    changes: [
      change.upsert({ id: "43", revision: 1, name: "Ada" }),
      change.upsert({ id: "44", revision: 1, name: "Grace" }),
    ],
  })
  // Sequence 8 of "42" is in the lake with other content.
  const againstLake = await refusedByLake.datasets.ingest(people, {
    changes: [change.upsert({ id: "42", revision: 8, name: "Conflict" })],
  })
  // Sequence 1 of "44" is in this batch with other content: the later delivery is refused.
  const againstBatch = await refusedByBatch.datasets.ingest(people, {
    changes: [
      change.upsert({ id: "45", revision: 1, name: "Linus" }),
      change.upsert({ id: "44", revision: 1, name: "Other" }),
    ],
  })

  expect(await flush()).toEqual({ kind: "flushed", versions: 1, deliveries: 1 })
  expect((await rows()).map((row) => row.name)).toEqual(["Sam", "Ada", "Grace"])

  const rejected = (await reported()).filter((report) => report.type === "dataset.ingest.rejected")
  expect(rejected).toEqual([
    expect.objectContaining({
      datasetId: people.id,
      deliveryId: againstLake.deliveryId,
      executionId: refusedByLake.execution.id,
      changeIndex: 0,
      key: { id: "42" },
      sequence: "8",
      failure: expect.objectContaining({ code: "dataset.change_refused" }),
    }),
    expect.objectContaining({
      deliveryId: againstBatch.deliveryId,
      executionId: refusedByBatch.execution.id,
      changeIndex: 1,
      key: { id: "44" },
      sequence: "1",
    }),
  ])
})

test("a tie refuses the change that conflicts, not a resend of what the lake holds", async () => {
  // Regression proof: in `findConflicting`, refuse the last change at the key and sequence
  // instead of the first with the refused content; the resend is dropped, and Ada with it.
  const { scope, ingest, flush, rows, reported } = setup()
  await ingest(people, change.upsert({ id: "1", revision: 5, name: "A" }))
  await flush()

  // d1 conflicts with the lake; d2 sends the lake's own content again, and a new person.
  const d1 = await scope().datasets.ingest(people, {
    changes: [change.upsert({ id: "1", revision: 5, name: "B" })],
  })
  await scope().datasets.ingest(people, {
    changes: [
      change.upsert({ id: "1", revision: 5, name: "A" }),
      change.upsert({ id: "2", revision: 1, name: "Ada" }),
    ],
  })

  expect(await flush()).toEqual({ kind: "flushed", versions: 1, deliveries: 1 })
  expect((await rows()).map((row) => row.name)).toEqual(["A", "Ada"])

  const rejected = (await reported()).filter((report) => report.type === "dataset.ingest.rejected")
  expect(rejected).toEqual([expect.objectContaining({ deliveryId: d1.deliveryId })])
})

test("a change that stopped being valid since ingest is refused, and the rest commits", async () => {
  // Regression proof: refuse nothing in `mapValidationError` (return the error as it is); the
  // flush fails on the deleted blob and writes nothing.
  const { blobStorage, scope, flush, rows, reported } = setup()
  const kept = await blobStorage.put({ body: new TextEncoder().encode("kept") })
  const deleted = await blobStorage.put({ body: new TextEncoder().encode("deleted") })

  const sender = scope()
  await sender.datasets.ingest(documents, { changes: [change.upsert({ id: "1", file: kept })] })
  const refused = await sender.datasets.ingest(documents, {
    changes: [change.upsert({ id: "2", file: kept }), change.upsert({ id: "3", file: deleted })],
  })

  // The blob is deleted between ingest and flush.
  const stat = blobStorage.stat.bind(blobStorage)
  blobStorage.stat = async (blobId) => (blobId === deleted.blobId ? null : stat(blobId))

  expect(await flush(documents)).toEqual({ kind: "flushed", versions: 1, deliveries: 1 })
  expect((await rows(documents)).map((row) => row.id)).toEqual(["1"])

  const rejected = (await reported()).filter((report) => report.type === "dataset.ingest.rejected")
  expect(rejected).toEqual([
    expect.objectContaining({
      deliveryId: refused.deliveryId,
      executionId: sender.execution.id,
      changeIndex: 1,
      key: { id: "3" },
      failure: expect.objectContaining({ code: "dataset.change_refused" }),
    }),
  ])
})

test("a worker older than the API never refuses what the API stored", async () => {
  // Regression proof: drop the `definitionHash` check from `reject`; the old worker then finds an
  // unknown column, and refuses a row nothing is wrong with.
  const contactsV1 = defineDataset("source.versioned", {
    schema: [col("id", "string"), col("name", "string")],
    primaryKey: "id",
  })
  const contactsV2 = defineDataset("source.versioned", {
    schema: [col("id", "string"), col("name", "string"), col("nick", "string", { nullable: true })],
    primaryKey: "id",
  })

  const storage = new InMemoryStorage()
  const lakeStorage = new InMemoryLakeStorage()
  const reports: SixbErrorContext[] = []
  const hostOn = (dataset: DatasetDefinition) =>
    new SixbHost({
      id: "rolling-deploy",
      ontology: [],
      datasets: [dataset],
      lakeStorage,
      broker: new InMemoryBroker(),
      storage,
      queues: new InMemoryQueues(),
      blobStorage: new InMemoryBlobStorage(),
      onError: (_error, context) => {
        reports.push(context)
      },
    })

  // The API runs the new code, and a lake worker still runs the old.
  const api = hostOn(contactsV2)
  const oldWorker = hostOn(contactsV1)

  await api.withScope(createTestingScope({ projectId: api.id })).datasets.ingest(contactsV2, {
    changes: [change.upsert({ id: "1", name: "Ada", nick: "Countess" })],
  })

  const failure = await getDatasetIngestRuntime(oldWorker)
    .flush(contactsV2.id, new AbortController().signal)
    .catch((error) => error)

  expect(failure).toBeInstanceOf(DatasetIngestFlushError)
  await flushSixbErrors(oldWorker)
  expect(reports).toEqual([])
  expect(await storage.datasetIngest.summarize({ projectId: api.id })).toMatchObject([
    { datasetId: contactsV2.id, pendingDeliveries: 1 },
  ])
})

test("a delivery holding a value the lake cannot hold is refused, and the rest commits", async () => {
  // Regression proof: drop `LakeValueRefusedError` from `refusedChange`; every attempt fails on the
  // whole batch, and no delivery of the dataset is written again.
  const { scope, ingest, flush, rows, reported } = setup(
    new RefusingLakeStorage((name) => name === "1.0000000001")
  )
  await ingest(contacts, change.upsert({ id: "1", name: "ok" }))
  const sender = scope()
  const refused = await sender.datasets.ingest(contacts, {
    changes: [
      change.upsert({ id: "2", name: "fine" }),
      change.upsert({ id: "3", name: "1.0000000001" }),
    ],
  })
  await ingest(contacts, change.upsert({ id: "4", name: "later" }))

  expect(await flush(contacts)).toEqual({ kind: "flushed", versions: 1, deliveries: 2 })
  expect((await rows(contacts)).map((row) => row.name)).toEqual(["ok", "later"])

  const rejected = (await reported()).filter((report) => report.type === "dataset.ingest.rejected")
  expect(rejected).toEqual([
    expect.objectContaining({
      deliveryId: refused.deliveryId,
      executionId: sender.execution.id,
      changeIndex: 1,
      key: { id: "3" },
      failure: expect.objectContaining({ code: "dataset.change_refused" }),
    }),
  ])

  // A lone delivery the lake refuses is refused as well.
  await ingest(contacts, change.upsert({ id: "5", name: "1.0000000001" }))
  expect(await flush(contacts)).toEqual({ kind: "flushed", versions: 0, deliveries: 0 })
  expect(
    (await reported()).filter((report) => report.type === "dataset.ingest.rejected")
  ).toHaveLength(2)
})

test("two deliveries the lake refuses never hold the dataset back", async () => {
  // Regression proof: fail the attempt when every delivery of a batch is refused, as `isolate` did:
  // the same batch then comes back on each attempt, with everything behind it.
  const lakeStorage = new RefusingLakeStorage((name) => name === "unstorable")
  const { host, storage, ingest, flush, rows } = setup(lakeStorage)

  await ingest(contacts, change.upsert({ id: "1", name: "unstorable" }))
  await ingest(contacts, change.upsert({ id: "2", name: "unstorable" }))
  await ingest(contacts, change.upsert({ id: "3", name: "unstorable" }))

  await flush(contacts).catch(() => {})
  await ingest(contacts, change.upsert({ id: "4", name: "Ada" }))
  await flush(contacts).catch(() => {})

  expect((await rows(contacts)).map((row) => row.id)).toEqual(["4"])
  expect(await storage.datasetIngest.summarize({ projectId: host.id })).toMatchObject([
    { datasetId: contacts.id, pendingDeliveries: 0, rejectedDeliveries: 3 },
  ])
})

test("a refused delivery keeps everything it held, and its report says how much", async () => {
  // Regression proof: delete the delivery in `reject`, as it once did; of a call of 3 changes with
  // one bad value, the other 2 are then stored nowhere.
  const lakeStorage = new RefusingLakeStorage((name) => name === "unstorable")
  const { host, storage, scope, flush, reported } = setup(lakeStorage)
  const changes = [
    change.upsert({ id: "1", name: "Ada" }),
    change.upsert({ id: "2", name: "unstorable" }),
    change.upsert({ id: "3", name: "Grace" }),
  ]
  const { deliveryId } = await scope().datasets.ingest(contacts, { changes })

  await flush(contacts)

  const rejected = await storage.datasetIngest.listRejected({ projectId: host.id, limit: 10 })
  expect(rejected).toHaveLength(1)
  expect(rejected[0]?.delivery.id).toBe(deliveryId ?? "")
  expect(rejected[0]?.changes).toEqual(changes)
  expect(rejected[0]?.reason).toContain("cannot hold")

  expect((await reported()).filter((report) => report.type === "dataset.ingest.rejected")).toEqual([
    expect.objectContaining({ deliveryId, changes: 3, changeIndex: 1, key: { id: "2" } }),
  ])
})

test("a lake error about its own state is retried, never refused, even for a lone delivery", async () => {
  // Regression proof: treat every LakeStorageError as a refusal in `refusedChange`; the lone
  // delivery is dropped and reported as refused.
  const { ingest, flush, reported, storage, host } = setup(
    new RefusingLakeStorage(
      () => true,
      () => new LakeStorageError("[TestLake] Unknown dataset 'source.contacts'.")
    )
  )
  await ingest(contacts, change.upsert({ id: "1", name: "Ada" }))

  expect(await flush(contacts).catch((error) => error)).toBeInstanceOf(DatasetIngestFlushError)
  expect(await storage.datasetIngest.summarize({ projectId: host.id })).toMatchObject([
    { datasetId: contacts.id, pendingDeliveries: 1 },
  ])
  expect((await reported()).filter((report) => report.type === "dataset.ingest.rejected")).toEqual(
    []
  )
})

test("a blob storage error at flush is retried, never refused", async () => {
  // Regression proof: refuse every error in `mapValidationError`; the delivery is dropped and
  // reported as refused although its blob exists.
  const { blobStorage, ingest, flush, rows, reported, storage, host } = setup()
  const file = await blobStorage.put({ body: new TextEncoder().encode("hello") })
  await ingest(documents, change.upsert({ id: "1", file }))

  const stat = blobStorage.stat.bind(blobStorage)
  blobStorage.stat = async () => {
    throw new Error("ECONNRESET")
  }
  const failed = await flush(documents).catch((error) => error)
  blobStorage.stat = stat

  expect(failed).toBeInstanceOf(DatasetIngestFlushError)
  expect(await storage.datasetIngest.summarize({ projectId: host.id })).toMatchObject([
    { datasetId: documents.id, pendingDeliveries: 1 },
  ])

  expect(await flush(documents)).toEqual({ kind: "flushed", versions: 1, deliveries: 1 })
  expect((await rows(documents)).map((row) => row.id)).toEqual(["1"])
  expect((await reported()).filter((report) => report.type === "dataset.ingest.rejected")).toEqual(
    []
  )
})

test("a flush that dies after its commit is resumed without writing its batch again", async () => {
  // Regression proof: start a resumed batch as a new one (skip `findCommitted` on resume); the
  // batch is written again over the sync's newer value, as a third version.
  const { storage, lakeStorage, ingest, flush, committed, rows } = setup()
  await ingest(contacts, change.upsert({ id: "1", name: "From the webhook" }))

  const complete = storage.datasetIngest.complete
  storage.datasetIngest.complete = async () => {
    throw new Error("worker stopped")
  }
  const died = await flush(contacts).catch((error) => error)
  storage.datasetIngest.complete = complete

  expect(died).toBeInstanceOf(DatasetIngestFlushError)
  expect(await lakeStorage.listVersions(contacts.id)).toHaveLength(1)

  // Before the batch is resumed, a sync writes a newer value.
  await writeDataset({
    lakeStorage,
    blobStorage: new InMemoryBlobStorage(),
    dataset: contacts,
    mode: "merge",
    signal: new AbortController().signal,
    readValues: async () => [{ value: change.upsert({ id: "1", name: "From the sync" }) }],
  })

  expect(await flush(contacts)).toEqual({ kind: "flushed", versions: 1, deliveries: 1 })
  expect(await lakeStorage.listVersions(contacts.id)).toHaveLength(2)
  expect((await rows(contacts)).map((row) => row.name)).toEqual(["From the sync"])

  // The dead flush announced its version before it died, and the resumed one again: at least once.
  const announced = await committed()
  expect(announced.map((event) => event.payload.datasetId)).toEqual([contacts.id, contacts.id])
  expect(new Set(announced.map((event) => event.payload.versionId)).size).toBe(1)
})

test("a batch resumes however many versions landed while its flush was down", async () => {
  // Regression proof: throw past the first LOOKUP_VERSIONS in `findCommitted`, as it did: resuming
  // is the only path, so the dataset then never moves.
  jest.useFakeTimers()
  const lakeStorage = new InMemoryLakeStorage()
  const { host, storage, ingest, flush, rows } = setup(lakeStorage)
  await ingest(contacts, change.upsert({ id: "1", name: "Ada" }))

  // A flush takes the batch and dies before it commits.
  const dead = await storage.datasetIngest.acquire({
    projectId: host.id,
    datasetId: contacts.id,
    owner: "dead-flush",
    leaseMs: 0,
  })
  if (!dead.acquired) throw new Error("expected the test to hold the lease")
  await storage.datasetIngest.takeBatch({
    lease: dead.lease,
    flushId: "flush_dead",
    maxChanges: 100,
  })

  // A sync goes on writing the dataset meanwhile.
  for (let round = 0; round < 201; round += 1) {
    // Each its own millisecond: versions are ordered by when they were committed.
    jest.advanceTimersByTime(1)
    await writeDataset({
      lakeStorage,
      blobStorage: new InMemoryBlobStorage(),
      dataset: contacts,
      mode: "append",
      signal: new AbortController().signal,
      readValues: async () => [{ value: { id: `sync-${round}`, name: "Sync" } }],
    })
  }

  expect(await flush(contacts)).toEqual({ kind: "flushed", versions: 1, deliveries: 1 })
  expect((await rows(contacts)).map((row) => row.id)).toContain("1")
})

test("a batch that committed is found however many versions landed after it", async () => {
  // Regression proof: return null past the first LOOKUP_VERSIONS in `findCommitted`; the old batch
  // is then merged again, over the newer write to its key.
  jest.useFakeTimers()
  const lakeStorage = new InMemoryLakeStorage()
  const { storage, ingest, flush, rows } = setup(lakeStorage)
  await ingest(contacts, change.upsert({ id: "1", name: "Ada" }))

  // The flush dies between its commit and deleting the batch, and a sync writes on.
  const complete = storage.datasetIngest.complete.bind(storage.datasetIngest)
  storage.datasetIngest.complete = async () => {
    throw new Error("killed")
  }
  await flush(contacts).catch(() => {})
  storage.datasetIngest.complete = complete

  for (let round = 0; round < 201; round += 1) {
    // Each its own millisecond: versions are ordered by when they were committed.
    jest.advanceTimersByTime(1)
    await writeDataset({
      lakeStorage,
      blobStorage: new InMemoryBlobStorage(),
      dataset: contacts,
      mode: "merge",
      signal: new AbortController().signal,
      readValues: async () => [{ value: change.upsert({ id: "1", name: `Sync ${round}` }) }],
    })
  }

  expect(await flush(contacts)).toEqual({ kind: "flushed", versions: 1, deliveries: 1 })

  expect((await rows(contacts)).map((row) => row.name)).toEqual(["Sync 200"])
})

test("a version whose announcement fails is announced when its batch is resumed", async () => {
  // Regression proof: complete the batch before announcing it in \`flushBatches\`; the batch is
  // gone when the announcement fails, and no flush ever announces the version.
  const { broker, ingest, flush, committed, lakeStorage } = setup()
  await ingest(contacts, change.upsert({ id: "1", name: "Ada" }))

  const append = broker.append.bind(broker)
  broker.append = async () => {
    throw new Error("broker offline")
  }
  const failed = await flush(contacts).catch((error) => error)
  broker.append = append

  expect(failed).toBeInstanceOf(DatasetIngestFlushError)
  expect(await committed()).toEqual([])

  expect(await flush(contacts)).toEqual({ kind: "flushed", versions: 1, deliveries: 1 })
  expect(await lakeStorage.listVersions(contacts.id)).toHaveLength(1)
  expect(await committed()).toHaveLength(1)
})

test("a flush whose lease expired commits nothing twice when it wakes", async () => {
  // Regression proof: in `commit`, rethrow a LakeConcurrencyError without looking for the batch;
  // the woken flush then fails as if the lake had refused it, instead of finding it committed.
  jest.useFakeTimers()
  const lakeStorage = new InMemoryLakeStorage()
  const { storage, ingest, flush } = setup(lakeStorage)
  await ingest(contacts, change.upsert({ id: "1", name: "Ada" }))

  const paused = Promise.withResolvers<void>()
  const wake = Promise.withResolvers<void>()
  const beginMerge = lakeStorage.beginMerge.bind(lakeStorage)
  let calls = 0
  lakeStorage.beginMerge = async (input) => {
    const session = await beginMerge(input)
    calls += 1
    if (calls === 1) {
      paused.resolve()
      await wake.promise
    }
    return session
  }

  const sleeper = flush(contacts).catch((error) => error)
  await paused.promise

  // Its lease expires; another flush resumes the batch and commits it.
  jest.setSystemTime(new Date(Date.now() + 61_000))
  expect(await flush(contacts)).toEqual({ kind: "flushed", versions: 1, deliveries: 1 })

  wake.resolve()
  const woken = await sleeper

  expect(woken).toBeInstanceOf(Error)
  expect((woken as Error).name).toBe("DatasetIngestLeaseLostError")
  expect(await lakeStorage.listVersions(contacts.id)).toHaveLength(1)

  // The woken flush counted no failure: the next delivery finds a clean streak.
  await ingest(contacts, change.upsert({ id: "2", name: "Grace" }))
  expect(await storage.datasetIngest.summarize({ projectId: "ingest-flush-test" })).toMatchObject([
    { pendingDeliveries: 1, failureStreak: 0 },
  ])
})

test("a flush paused before it writes stops when another resumed its batch meanwhile", async () => {
  // Regression proof: drop \`assertOwned\` from \`commit\`; the paused flush writes the batch a
  // second time on top of the other's version.
  jest.useFakeTimers()
  const { storage, ingest, flush, lakeStorage } = setup()
  await ingest(contacts, change.upsert({ id: "1", name: "Ada" }))

  // The first flush pauses once it has taken its batch.
  const paused = Promise.withResolvers<void>()
  const wake = Promise.withResolvers<void>()
  const takeBatch = storage.datasetIngest.takeBatch.bind(storage.datasetIngest)
  let takes = 0
  storage.datasetIngest.takeBatch = async (input) => {
    const batch = await takeBatch(input)
    takes += 1
    if (takes === 1) {
      paused.resolve()
      await wake.promise
    }
    return batch
  }

  const sleeper = flush(contacts).catch((error) => error)
  await paused.promise

  // Its lease expires. Another flush resumes the batch and writes it, but has not deleted it yet.
  jest.setSystemTime(new Date(Date.now() + 61_000))
  const written = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const complete = storage.datasetIngest.complete.bind(storage.datasetIngest)
  storage.datasetIngest.complete = async (input) => {
    written.resolve()
    await release.promise
    return complete(input)
  }
  const other = flush(contacts)
  await written.promise

  wake.resolve()
  expect(((await sleeper) as Error).name).toBe("DatasetIngestLeaseLostError")

  release.resolve()
  expect(await other).toEqual({ kind: "flushed", versions: 1, deliveries: 1 })
  expect(await lakeStorage.listVersions(contacts.id)).toHaveLength(1)
})

test("a flush that writes right after taking its batch does not ask whether it still holds it", async () => {
  // Regression proof: renew in \`assertOwned\` whatever \`ownedUntil\` says; every batch then
  // costs one more database round trip before its write.
  const { storage, ingest, flush } = setup()
  await ingest(contacts, change.upsert({ id: "1", name: "Ada" }))

  let renewals = 0
  const renew = storage.datasetIngest.renew.bind(storage.datasetIngest)
  storage.datasetIngest.renew = async (input) => {
    renewals += 1
    return renew(input)
  }

  expect(await flush(contacts)).toEqual({ kind: "flushed", versions: 1, deliveries: 1 })
  expect(renewals).toBe(0)
})

test("a flush that runs past its lease renews it, and stops when it loses it", async () => {
  // Regression proof: drop the \`setInterval\` renewal from \`run\`; the second flush takes the
  // dataset after 60 s. Drop the \`lost\` abort from \`renew\`; the flush that lost it writes.
  jest.useFakeTimers()
  const lakeStorage = new InMemoryLakeStorage()
  const { storage, ingest, flush, host } = setup(lakeStorage)
  await ingest(contacts, change.upsert({ id: "1", name: "Ada" }))

  const writing = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const beginMerge = lakeStorage.beginMerge.bind(lakeStorage)
  lakeStorage.beginMerge = async (input) => {
    writing.resolve()
    await finish.promise
    return beginMerge(input)
  }

  const running = flush(contacts).catch((error) => error)
  await writing.promise

  // A minute and a half of writing: the lease, renewed every 15 s, stays the first flush's.
  for (let tick = 0; tick < 6; tick += 1) {
    jest.advanceTimersByTime(15_000)
    await turns()
  }
  const second = await storage.datasetIngest.acquire({
    projectId: host.id,
    datasetId: contacts.id,
    owner: "another-worker",
    leaseMs: 60_000,
  })
  expect(second.acquired).toBe(false)

  // The lease is lost: the next renewal stops the flush before it writes.
  storage.datasetIngest.renew = async () => null
  jest.advanceTimersByTime(15_000)
  await turns()
  finish.resolve()

  expect(((await running) as Error).name).toBe("DatasetIngestLeaseLostError")
  expect(await lakeStorage.listVersions(contacts.id)).toEqual([])
})

test("a dataset whose flushes keep failing is reported once, at the fifth failure in a row", async () => {
  // Regression proof: report at every failure; six reports arrive.
  const lakeStorage = new InMemoryLakeStorage()
  const { ingest, flush, reported } = setup(lakeStorage)
  await ingest(people, change.upsert({ id: "42", revision: 8, name: "Sam" }))

  lakeStorage.beginMerge = async () => {
    throw new Error("lake offline")
  }

  const streaks: number[] = []
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const failed = await flush().catch((error) => error)
    streaks.push((failed as DatasetIngestFlushError).failureStreak)
  }
  expect(streaks).toEqual([1, 2, 3, 4, 5, 6])

  const failures = (await reported()).filter(
    (report) => report.type === "dataset.ingest.flush.failed"
  )
  expect(failures).toEqual([
    expect.objectContaining({
      datasetId: people.id,
      failureStreak: 5,
      pendingDeliveries: 1,
      failure: expect.objectContaining({ code: "internal.unexpected" }),
    }),
  ])
})

test("a flush that spends its budget asks for the next job and leaves the rest", async () => {
  // Regression proof: drop `requestAgain` when the budget is spent; the second delivery then
  // waits with no request open.
  jest.useFakeTimers()
  const lakeStorage = new InMemoryLakeStorage()
  const { host, storage, queues, ingest, flush } = setup(lakeStorage)

  // Two deliveries that each fill a batch.
  const batchOf = (from: number) =>
    Array.from({ length: 10_000 }, (_, index) =>
      change.upsert({ id: `${from + index}`, name: "N" })
    )
  await ingest(contacts, ...batchOf(0))
  await ingest(contacts, ...batchOf(10_000))

  // The first batch takes the whole budget.
  const beginMerge = lakeStorage.beginMerge.bind(lakeStorage)
  lakeStorage.beginMerge = async (input) => {
    jest.setSystemTime(new Date(Date.now() + 31_000))
    return beginMerge(input)
  }

  expect(await flush(contacts)).toEqual({ kind: "handed-over", versions: 1, deliveries: 1 })
  expect(await storage.datasetIngest.summarize({ projectId: host.id })).toMatchObject([
    { datasetId: contacts.id, pendingDeliveries: 1, leaseExpiresAt: null },
  ])

  const queued = await queues.lake.claim({ projectId: host.id, workerId: "test", limit: 10 })
  expect(queued.map(({ job }) => job.id)).toEqual([
    `ingest-flush:${contacts.id}:0`,
    `ingest-flush:${contacts.id}:2`,
  ])
})

test("an inline flush goes on past its budget, with no job for what remains", async () => {
  // Regression proof: return after the first flush in `flushAll`; the second delivery then waits
  // in an embedded server, where no worker would consume a job.
  jest.useFakeTimers()
  const lakeStorage = new InMemoryLakeStorage()
  const { host, storage, queues, ingest } = setup(lakeStorage)

  const batchOf = (from: number) =>
    Array.from({ length: 10_000 }, (_, index) =>
      change.upsert({ id: `${from + index}`, name: "N" })
    )
  await ingest(contacts, ...batchOf(0))
  await ingest(contacts, ...batchOf(10_000))

  const beginMerge = lakeStorage.beginMerge.bind(lakeStorage)
  lakeStorage.beginMerge = async (input) => {
    jest.setSystemTime(new Date(Date.now() + 31_000))
    return beginMerge(input)
  }

  const runtime = getDatasetIngestRuntime(host)
  runtime.writesInline = true
  await runtime.flushAll(contacts.id, new AbortController().signal)

  expect(await storage.datasetIngest.summarize({ projectId: host.id })).toEqual([])

  // Only the job the first `ingest` queued, before the switch.
  const queued = await queues.lake.claim({ projectId: host.id, workerId: "test", limit: 10 })
  expect(queued.map(({ job }) => job.id)).toEqual([`ingest-flush:${contacts.id}:0`])
})

test("a flush that spent its budget ends cleanly when the queue refuses the next job", async () => {
  // Regression proof: call `enqueueIngestFlush` from `requestAgain`; the batch is committed, yet
  // the attempt then fails and counts against the dataset.
  jest.useFakeTimers()
  const lakeStorage = new InMemoryLakeStorage()
  const { host, storage, queues, ingest, flush } = setup(lakeStorage)

  await ingest(contacts, change.upsert({ id: "1", name: "Ada" }))
  await ingest(contacts, change.upsert({ id: "2", name: "Grace" }))

  const beginMerge = lakeStorage.beginMerge.bind(lakeStorage)
  lakeStorage.beginMerge = async (input) => {
    jest.setSystemTime(new Date(Date.now() + 31_000))
    queues.lake.enqueue = async () => {
      throw new Error("queue offline")
    }
    return beginMerge(input)
  }

  // A third delivery after the batch was taken is what the next job has to write.
  const take = storage.datasetIngest.takeBatch.bind(storage.datasetIngest)
  storage.datasetIngest.takeBatch = async (input) => {
    const batch = await take(input)
    await ingest(contacts, change.upsert({ id: "3", name: "Edsger" }))
    return batch
  }

  const warn = console.warn
  console.warn = () => {}
  try {
    expect(await flush(contacts)).toEqual({ kind: "handed-over", versions: 1, deliveries: 2 })
  } finally {
    console.warn = warn
  }

  expect(await storage.datasetIngest.summarize({ projectId: host.id })).toMatchObject([
    { datasetId: contacts.id, pendingDeliveries: 1, failureStreak: 0, leaseExpiresAt: null },
  ])
})

test("a flush that keeps failing keeps one request, so an outage queues no more jobs", async () => {
  // Regression proof: move the request in `acquire`; each attempt then lets a delivery open a new
  // request, whose job retries beside the others for as long as the outage lasts.
  const lakeStorage = new InMemoryLakeStorage()
  const { host, queues, ingest, flush } = setup(lakeStorage)
  lakeStorage.beginMerge = async () => {
    throw new Error("lake offline")
  }

  await ingest(contacts, change.upsert({ id: "1", name: "Ada" }))
  await flush(contacts).catch(() => {})
  await ingest(contacts, change.upsert({ id: "2", name: "Grace" }))
  await flush(contacts).catch(() => {})
  await ingest(contacts, change.upsert({ id: "3", name: "Edsger" }))

  // Taking the batch closed the first request; the deliveries after it share the next.
  const queued = await queues.lake.claim({ projectId: host.id, workerId: "test", limit: 10 })
  expect(queued.map(({ job }) => job.id)).toEqual([
    `ingest-flush:${contacts.id}:0`,
    `ingest-flush:${contacts.id}:1`,
  ])
})

test("a second flush of the dataset waits for the first", async () => {
  const lakeStorage = new InMemoryLakeStorage()
  const { ingest, flush } = setup(lakeStorage)
  await ingest(contacts, change.upsert({ id: "1", name: "Ada" }))

  const paused = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const beginMerge = lakeStorage.beginMerge.bind(lakeStorage)
  lakeStorage.beginMerge = async (input) => {
    paused.resolve()
    await resume.promise
    return beginMerge(input)
  }

  const first = flush(contacts)
  await paused.promise

  const second = await flush(contacts)
  expect(second.kind).toBe("busy")

  resume.resolve()
  expect(await first).toEqual({ kind: "flushed", versions: 1, deliveries: 1 })
})

/** A fixed mix of upserts and deletes over three keys, some of them out of source order. */
function scriptedDeliveries(dataset: DatasetDefinition): MergeChange<DatasetRow, DatasetRow>[][] {
  const sequenced = dataset.sequenceBy !== undefined
  let seed = 7
  const next = (modulo: number) => {
    seed = (seed * 48_271) % 2_147_483_647
    return seed % modulo
  }

  // Unique revisions, shuffled: some changes arrive after newer ones, none tie.
  const revisions = Array.from({ length: 30 }, (_, index) => index + 1)
  for (let index = revisions.length - 1; index > 0; index -= 1) {
    const swap = next(index + 1)
    ;[revisions[index], revisions[swap]] = [revisions[swap]!, revisions[index]!]
  }

  const deliveries: MergeChange<DatasetRow, DatasetRow>[][] = []
  let used = 0
  while (used < revisions.length) {
    const size = Math.min(1 + next(3), revisions.length - used)
    const delivery = revisions.slice(used, used + size).map((revision) => {
      const id = `k${next(3)}`
      if (next(4) === 0) {
        return sequenced ? change.delete({ id }, { sequence: revision }) : change.delete({ id })
      }
      return change.upsert(
        sequenced ? { id, revision, name: `r${revision}` } : { id, name: `r${revision}` }
      )
    })
    deliveries.push(delivery)
    used += size
  }

  return deliveries
}

async function readAll(lakeStorage: InMemoryLakeStorage, dataset: DatasetDefinition) {
  const version = await lakeStorage.getLatestVersion(dataset.id)
  if (!version) return []

  const all: DatasetRow[] = []
  for await (const row of lakeStorage.readRows({
    datasetId: dataset.id,
    versionId: version.versionId,
  })) {
    all.push(row)
  }
  return all.sort((left, right) => String(left.id).localeCompare(String(right.id)))
}

/** Lets pending promise callbacks run: fake timers stop the clock a timeout would use. */
async function turns(count = 20): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) await Promise.resolve()
}
