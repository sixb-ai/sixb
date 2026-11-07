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
import { LakeValueRefusedError } from "@sixb/core/lake-storage"
import { DatasetValidationError } from "../../../packages/core/src/datasets/errors"
import { datasetDefinitionHash } from "../../../packages/core/src/datasets/ingest-flush-job"
import { createTestingScope } from "../../../packages/core/src/execution/scopes"
import type { DuckLakeStorage } from "../src"
import { createLocalDuckLakeStorage } from "./test-utils"

const invoices = defineDataset("raw.invoices", {
  schema: [
    col("id", "string"),
    col("amount", "decimal", { nullable: true }),
    col("issued_at", "timestamp", { nullable: true }),
    col("issued_on", "date", { nullable: true }),
    col("count", "int64", { nullable: true }),
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

// What `ingest` refuses in the request, against what DuckDB refuses when it stages the value: a
// check stricter than DuckDB would turn working webhooks away, and a looser one answers 200 for a
// change it then drops. Reproduce: relax TIMESTAMP_FORMAT in value-limits.ts to `.*`.
test("ingest refuses exactly what DuckDB refuses, for what its schema lets through", async () => {
  const { lakeStorage } = await setup()
  await lakeStorage.createDataset(invoices)

  const staged = async (row: DatasetRow) => {
    const session = await lakeStorage.beginMerge({ dataset: invoices })
    try {
      await session.writeChanges([change.upsert({ id: "1", ...row })])
      return "holds"
    } catch (error) {
      if (error instanceof LakeValueRefusedError) return "refuses"
      throw error
    } finally {
      await session.abort().catch(() => {})
    }
  }
  const checked = (row: DatasetRow) => {
    try {
      lakeStorage.assertHoldsChanges(invoices, [change.upsert({ id: "1", ...row })])
      return "holds"
    } catch (error) {
      if (error instanceof LakeValueRefusedError) return "refuses"
      throw error
    }
  }

  const rows: DatasetRow[] = [
    ...[
      "2026-09-09T10:00:00.123Z",
      "2026-09-09 10:00:00",
      "2026-09-09T10:00:00",
      "2026-09-09",
      "2026-09-09T10:00",
      "2026-09-09 10:00:00+02",
      "2026-09-09T10:00:00+02:00",
      "2026-09-09T10:00:00+0200",
      "2026-09-09T10:00:00.123456789Z",
      "2026-9-9 1:2:3",
      "2026-09-09T24:00:00Z",
      "2026/09/09",
      "2026/09/09 10:00:00",
      "0000-01-01T00:00:00Z",
      "2024-02-29T10:00:00Z",
      "2026-02-29T10:00:00Z",
      "2026-02-30T10:00:00Z",
      "Mon, 09 Sep 2026 10:00:00 GMT",
      "9/9/2026",
      "Sep 9, 2026 10:00 AM",
      "Sep 9 2026",
      "2026-09-09 10:00:00 GMT",
      "+012026-09-09T10:00:00Z",
      "2026-09-09T10:00:00z",
      "+275760-09-13T00:00:00.000Z",
    ].map((issued_at) => ({ issued_at })),
    ...["2026-09-09", "2024-02-29", "2026-02-29", "2026-02-30", "0000-01-01"].map((issued_on) => ({
      issued_on,
    })),
    ...[
      "120.50",
      "1.000000001",
      "1.0000000001",
      "12345678901234567890123456789",
      "123456789012345678901234567890",
    ].map((amount) => ({ amount })),
    ...[
      "9223372036854775807",
      "9223372036854775808",
      "-9223372036854775808",
      "-9223372036854775809",
      "007",
    ].map((count) => ({ count })),
  ]

  for (const row of rows) expect([row, checked(row)]).toEqual([row, await staged(row)])
})

// Reproduce: remove `assertHoldsChanges` from DuckLakeStorage, and `ingest` answers for changes
// the lake will refuse.
test("a value DuckDB cannot read is refused to the caller, and nothing is stored", async () => {
  const { host } = await setup()
  const sixb = host.withScope(createTestingScope({ projectId: host.id }))

  const failure = await sixb.datasets
    .ingest(invoices, {
      changes: [change.upsert({ id: "inv-1", issued_at: "Mon, 09 Sep 2026 10:00:00 GMT" })],
    })
    .catch((error) => error)

  expect(failure).toBeInstanceOf(DatasetValidationError)
  expect(await host.storage.datasetIngest?.summarize({ projectId: host.id })).toEqual([])
})

// What passes `ingest` can still reach a flush the lake refuses: a worker on another provider, or a
// stored row older than the check. Reproduce: drop `LakeValueRefusedError` from `refusedChange` in
// ingest-flush.ts; the batch then fails on each attempt, and nothing behind it is written.
test("deliveries DuckDB refuses at the flush never hold the others back", async () => {
  const { host, lakeStorage, reports } = await setup()
  const inbox = host.storage.datasetIngest
  if (!inbox) throw new Error("expected a storage with an inbox")

  const store = async (row: DatasetRow) => {
    const { delivery } = await inbox.append({
      projectId: host.id,
      datasetId: invoices.id,
      executionId: `exec-${String(row.id)}`,
      correlationId: `corr-${String(row.id)}`,
      definitionHash: datasetDefinitionHash(invoices),
      changes: [change.upsert(row)],
    })
    return delivery.id
  }

  // Good ones around the bad ones: the refusal has to name the right change, not the first.
  await store({ id: "inv-0", amount: "12.00" })
  const refused = [
    await store({ id: "inv-1", issued_at: "Mon, 09 Sep 2026 10:00:00 GMT" }),
    await store({ id: "inv-2", amount: "1.0000000001" }),
    await store({ id: "inv-3", issued_at: "9/9/2026" }),
  ]
  await store({ id: "inv-4", amount: "80.00" })

  const outcome = await getDatasetIngestRuntime(host).flush(
    invoices.id,
    new AbortController().signal
  )
  expect(outcome).toEqual({ kind: "flushed", versions: 1, deliveries: 2 })

  const rows: DatasetRow[] = []
  for await (const row of lakeStorage.readRows({ datasetId: invoices.id })) rows.push(row)
  expect(rows.map((row) => row.id).sort()).toEqual(["inv-0", "inv-4"])

  await flushSixbErrors(host)
  expect(
    reports
      .flatMap((report) => (report.type === "dataset.ingest.rejected" ? [report.deliveryId] : []))
      .sort()
  ).toEqual(refused.sort())
})
