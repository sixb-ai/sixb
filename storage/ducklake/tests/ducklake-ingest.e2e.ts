import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  change,
  col,
  type DatasetDefinition,
  type DatasetRow,
  defineDataset,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryQueues,
  InMemoryStorage,
  type SixbErrorContext,
  SixbHost,
} from "@sixb/core"
import { flushSixbErrors } from "@sixb/core/internal/error-reporting"
import { getDatasetIngestRuntime } from "@sixb/core/internal/runtime"
import { createTestingScope } from "../../../packages/core/src/execution/scopes"
import type { DuckLakeStorage } from "../src"
import { createLocalDuckLakeStorage } from "./test-utils"

const invoices = defineDataset("raw.invoices", {
  schema: [
    col("id", "string"),
    col("amount", "decimal", { nullable: true }),
    col("issued_at", "timestamp", { nullable: true }),
  ],
  primaryKey: "id",
})

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function setup() {
  const rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-ingest-"))
  const lakeStorage: DuckLakeStorage = createLocalDuckLakeStorage(rootDir, "duckdb")
  cleanups.push(async () => {
    await lakeStorage.close()
    await rm(rootDir, { recursive: true, force: true })
  })

  const reports: SixbErrorContext[] = []
  const host = new SixbHost({
    id: "ducklake-ingest",
    ontology: [],
    datasets: [invoices],
    lakeStorage,
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    queues: new InMemoryQueues(),
    blobStorage: new InMemoryBlobStorage(),
    lakeMaintenance: { enabled: false },
    onError: (_error, context) => {
      reports.push(context)
    },
  })

  return { host, lakeStorage, reports }
}

// A rollout that adds a nullable column, the one change a dataset allows: the API runs the new code
// beside a lake worker on the old. Reproduce: drop the `definitionHash` check from `reject` in
// ingest-flush.ts; the old worker then deletes the delivery.
test("a worker older than the API keeps the delivery, and the rollout writes it", async () => {
  const before = defineDataset("raw.rollout", {
    schema: [col("id", "string"), col("name", "string")],
    primaryKey: "id",
  })
  const after = defineDataset("raw.rollout", {
    schema: [col("id", "string"), col("name", "string"), col("nick", "string", { nullable: true })],
    primaryKey: "id",
  })

  const rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-rollout-"))
  const lakeStorage: DuckLakeStorage = createLocalDuckLakeStorage(rootDir, "duckdb")
  cleanups.push(async () => {
    await lakeStorage.close()
    await rm(rootDir, { recursive: true, force: true })
  })

  const storage = new InMemoryStorage()
  const reports: SixbErrorContext[] = []
  const hostOn = (dataset: DatasetDefinition) =>
    new SixbHost({
      id: "ducklake-rollout",
      ontology: [],
      datasets: [dataset],
      lakeStorage,
      broker: new InMemoryBroker(),
      storage,
      queues: new InMemoryQueues(),
      blobStorage: new InMemoryBlobStorage(),
      lakeMaintenance: { enabled: false },
      onError: (_error, context) => {
        reports.push(context)
      },
    })
  const flushOn = (host: SixbHost) =>
    getDatasetIngestRuntime(host).flush(after.id, new AbortController().signal)
  const pending = async () =>
    (await storage.datasetIngest.summarize({ projectId: "ducklake-rollout" })).map(
      (summary) => summary.pendingDeliveries
    )

  const oldWorker = hostOn(before)
  await oldWorker
    .withScope(createTestingScope({ projectId: oldWorker.id }))
    .datasets.ingest(before, { changes: [change.upsert({ id: "1", name: "Grace" })] })
  await flushOn(oldWorker)

  const api = hostOn(after)
  await api.withScope(createTestingScope({ projectId: api.id })).datasets.ingest(after, {
    changes: [change.upsert({ id: "2", name: "Ada", nick: "Countess" })],
  })

  await flushOn(oldWorker).catch(() => {})
  await flushSixbErrors(oldWorker)

  expect(await pending()).toEqual([1])
  expect(reports.filter((report) => report.type === "dataset.ingest.rejected")).toEqual([])

  expect(await flushOn(hostOn(after))).toEqual({ kind: "flushed", versions: 1, deliveries: 1 })
  expect(await pending()).toEqual([])

  const rows: DatasetRow[] = []
  for await (const row of lakeStorage.readRows({ datasetId: after.id })) rows.push(row)
  expect(rows.find((row) => row.id === "2")).toMatchObject({ nick: "Countess" })
})

// Reproduce: rethrow every error as it is in `appendDatasetRow` (row-appender.ts); the batch
// then fails as an outage on each attempt, and nothing is written.
test("refuses the deliveries holding values DuckDB cannot hold, and writes the others", async () => {
  const { host, lakeStorage, reports } = await setup()
  const sixb = host.withScope(createTestingScope({ projectId: host.id }))
  const ingest = (row: DatasetRow) =>
    sixb.datasets.ingest(invoices, { changes: [change.upsert(row)] })

  await ingest({ id: "inv-1", amount: "120.50" })
  // DECIMAL(38,9) holds nine fractional digits, and a DuckDB timestamp no year past 294,000.
  const decimal = await ingest({ id: "inv-2", amount: "1.0000000001" })
  const timestamp = await ingest({ id: "inv-3", issued_at: "+275760-09-13T00:00:00.000Z" })
  await ingest({ id: "inv-4", amount: "80.00" })

  const outcome = await getDatasetIngestRuntime(host).flush(
    invoices.id,
    new AbortController().signal
  )
  expect(outcome).toEqual({ kind: "flushed", versions: 1, deliveries: 2 })

  const rows: DatasetRow[] = []
  for await (const row of lakeStorage.readRows({ datasetId: invoices.id })) rows.push(row)
  expect(rows.map((row) => row.id).sort()).toEqual(["inv-1", "inv-4"])

  await flushSixbErrors(host)
  expect(reports.filter((report) => report.type === "dataset.ingest.rejected")).toEqual([
    expect.objectContaining({ deliveryId: decimal.deliveryId, key: { id: "inv-2" } }),
    expect.objectContaining({ deliveryId: timestamp.deliveryId, key: { id: "inv-3" } }),
  ])
})
