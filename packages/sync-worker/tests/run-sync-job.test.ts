import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  BlobStorage,
  ConnectorAdapter,
  ConnectorClient,
  ConnectorDefinition,
  DatasetDefinition,
  DatasetRow,
  FileRef,
  LakeStorage,
  SyncDefinition,
} from "@sixb/core"
import {
  change,
  col,
  defineConnector,
  defineDataset,
  defineSync,
  InMemoryBlobStorage,
  InMemoryLakeStorage,
  InMemoryStorage,
} from "@sixb/core"
import type { BeginDatasetWriteInput, LakeWriteSession } from "@sixb/core/lake-storage"
import type { ExecutionStorage, SyncRunRecord, SyncRunStorage } from "@sixb/core/storage"
import { LocalLakeStorage } from "@sixb/lake-local"
import { runSyncJob as runSyncJobWithDurableRun } from "../src/run-sync-job"
import type { RunSyncJobInput, SyncWorkerContext } from "../src/types"

const tempDirs: string[] = []
const executionsByRunStorage = new WeakMap<SyncRunStorage, ExecutionStorage>()

afterEach(async () => {
  while (tempDirs.length > 0) {
    const path = tempDirs.pop()
    if (path) {
      await rm(path, { recursive: true, force: true })
    }
  }
})

const erpDb = defineConnector("erpDb", {
  type: "sql",
  connect() {
    return {
      async query() {
        return []
      },
    }
  },
})

function makeDataset(id: string): DatasetDefinition {
  return defineDataset(id, {
    schema: [
      col("orderId", "string"),
      col("customerName", "string", { nullable: true }),
      col("status", "string", { nullable: true }),
      col("total", "float64", { nullable: true }),
      col("discountCode", "string", { nullable: true }),
      col("metadata", "json", { nullable: true }),
      col("tags", "json", { nullable: true }),
    ],
  })
}

const rawOrdersDataset = makeDataset("raw.erp.orders")
const rawSingleDataset = makeDataset("raw.erp.single")
const rawIterableDataset = makeDataset("raw.erp.iterable")
const rawAsyncDataset = makeDataset("raw.erp.async")
const keyedOrdersDataset = defineDataset("raw.erp.keyed-orders", {
  schema: rawOrdersDataset.schema.columns,
  primaryKey: "orderId",
})
const keyedLineItemsDataset = defineDataset("raw.erp.invoice-line-items", {
  schema: [col("invoiceId", "string"), col("lineItemId", "string"), col("status", "string")],
  primaryKey: ["invoiceId", "lineItemId"],
})
const rawDocsDataset = defineDataset("raw.docs", {
  schema: [col("id", "string"), col("attachment", "fileRef", { nullable: true })],
})
const keyedDocsDataset = defineDataset("raw.keyed-docs", {
  schema: rawDocsDataset.schema.columns,
  primaryKey: "id",
})

function createRuntime(options: {
  sync: SyncDefinition
  syncRunsStorage?: SyncRunStorage
  lakeStorage?: LakeStorage
  blobStorage?: BlobStorage
  client?: unknown
  onConnect?: () => Promise<void> | void
}): SyncWorkerContext {
  const syncRunsStorage = options.syncRunsStorage ?? createSyncRunStorage()
  const lakeStorage = options.lakeStorage ?? new InMemoryLakeStorage()
  const blobStorage = options.blobStorage ?? new InMemoryBlobStorage()
  const client = options.client ?? {}

  return {
    id: "project-1",
    syncRunsStorage,
    lakeStorage,
    blobs: blobStorage,
    datasets: {
      getById(datasetId: string) {
        return datasetId === options.sync.target.dataset.id ? options.sync.target.dataset : null
      },
    },
    syncs: {
      getById(syncId: string) {
        return syncId === options.sync.id ? options.sync : null
      },
    },
    async connector<TAdapter extends ConnectorAdapter>(
      _definition: ConnectorDefinition<string, TAdapter>
    ): Promise<ConnectorClient<TAdapter>> {
      await options.onConnect?.()
      return client as ConnectorClient<TAdapter>
    },
  }
}

function createSyncRunStorage(): SyncRunStorage {
  const provider = new InMemoryStorage()
  executionsByRunStorage.set(provider.syncRuns, provider.executions)
  return provider.syncRuns
}

function registerSyncRunStorage(
  storage: SyncRunStorage,
  executions: ExecutionStorage
): SyncRunStorage {
  executionsByRunStorage.set(storage, executions)
  return storage
}

interface TestSyncJob {
  readonly id: string
  readonly syncId: string
  readonly expectedLatestVersionId?: string
  readonly commitMessage?: string
}

type TestRunSyncJobInput = Omit<RunSyncJobInput, "run"> & {
  readonly job: TestSyncJob
}

async function queueTestSyncRun(runtime: SyncWorkerContext, job: TestSyncJob) {
  const existing = await runtime.syncRunsStorage.getById({ projectId: runtime.id, id: job.id })
  if (existing) return existing

  const sync = runtime.syncs.getById(job.syncId)
  if (!sync) throw new Error(`[Test] Unknown Sync '${job.syncId}'.`)
  const executions = executionsByRunStorage.get(runtime.syncRunsStorage)
  if (!executions) throw new Error("[Test] Sync run storage has no associated execution storage.")
  const executionId = `exec:${job.id}`
  await executions.create({
    id: executionId,
    projectId: runtime.id,
    executor: { type: "primitive", kind: "sync", runId: job.id },
    source: { type: "schedule", eventId: `event:${job.id}` },
    correlationId: `correlation:${job.id}`,
    authorizationRef: {
      type: "trustedPrimitive",
      primitive: { kind: "sync", id: job.syncId, runId: job.id },
    },
  })
  return runtime.syncRunsStorage.queue({
    id: job.id,
    projectId: runtime.id,
    executionId,
    syncId: job.syncId,
    datasetId: sync.target.dataset.id,
    mode: sync.config.mode,
    expectedLatestVersionId: job.expectedLatestVersionId,
    commitMessage: job.commitMessage,
  })
}

async function runSyncJob(input: TestRunSyncJobInput) {
  const { job, ...options } = input
  const run = await queueTestSyncRun(input.runtime, job)
  return runSyncJobWithDurableRun({ ...options, run })
}

async function startSyncRun(
  storage: SyncRunStorage,
  input: {
    readonly id: string
    readonly projectId: string
    readonly syncId: string
    readonly datasetId: string
    readonly mode: "snapshot" | "append" | "merge"
    readonly startedAt?: Date
  }
) {
  const executions = executionsByRunStorage.get(storage)
  if (!executions) throw new Error("[Test] Sync run storage has no associated execution storage.")
  const executionId = `exec:${input.id}`
  await executions.create({
    id: executionId,
    projectId: input.projectId,
    executor: { type: "primitive", kind: "sync", runId: input.id },
    source: { type: "schedule", eventId: `event:${input.id}` },
    correlationId: `correlation:${input.id}`,
    authorizationRef: {
      type: "trustedPrimitive",
      primitive: { kind: "sync", id: input.syncId, runId: input.id },
    },
  })
  const { startedAt, ...queuedRun } = input
  await storage.queue({ ...queuedRun, executionId, queuedAt: startedAt })
  return storage.start({
    id: input.id,
    projectId: input.projectId,
    startedAt: input.startedAt,
  })
}

async function collectRows(rows: AsyncIterable<DatasetRow>): Promise<DatasetRow[]> {
  const result: DatasetRow[] = []
  for await (const row of rows) {
    result.push(row)
  }
  return result
}

class RejectingFirstEmptyCommitLakeStorage extends InMemoryLakeStorage {
  override async beginWrite(input: BeginDatasetWriteInput): Promise<LakeWriteSession> {
    const write = await super.beginWrite(input)
    let rowsWritten = 0

    return {
      async writeRows(rows) {
        await write.writeRows(
          (async function* () {
            for await (const row of rows) {
              rowsWritten += 1
              yield row
            }
          })()
        )
      },
      commit: async (commitInput) => {
        if (rowsWritten === 0 && !(await this.getLatestVersion(input.dataset.id))) {
          throw new Error("A first empty commit cannot create a dataset version.")
        }
        return write.commit(commitInput)
      },
      abort: () => write.abort(),
    }
  }
}

describe("runSyncJob", () => {
  test("commits a snapshot sync, defines the dataset first, and stores a succeeded run", async () => {
    const calls: string[] = []
    const lakeStorage = new InMemoryLakeStorage()
    const wrappedLakeStorage: LakeStorage = {
      assertDatasetDefinitionsCompatible(definitions) {
        return lakeStorage.assertDatasetDefinitionsCompatible(definitions)
      },
      createDataset(definition) {
        calls.push(`create:${definition.id}`)
        return lakeStorage.createDataset(definition)
      },
      getDataset(datasetId) {
        return lakeStorage.getDataset(datasetId)
      },
      listDatasets() {
        return lakeStorage.listDatasets()
      },
      listDatasetCatalogState(datasetIds) {
        return lakeStorage.listDatasetCatalogState(datasetIds)
      },
      listVersions(datasetId, limit) {
        return lakeStorage.listVersions(datasetId, limit)
      },
      beginWrite(input) {
        calls.push(`begin:${input.dataset.id}`)
        return lakeStorage.beginWrite(input)
      },
      beginMerge(input) {
        return lakeStorage.beginMerge(input)
      },
      getLatestVersion(datasetId) {
        return lakeStorage.getLatestVersion(datasetId)
      },
      getVersion(datasetId, versionId) {
        return lakeStorage.getVersion(datasetId, versionId)
      },
      readRows(input) {
        return lakeStorage.readRows(input)
      },
    }

    let seenContext:
      | {
          projectId: string
          syncId: string
          signal: AbortSignal
        }
      | undefined

    const sync = defineSync("sync-orders")
      .from(erpDb)
      .read(async (_client, context) => {
        seenContext = context
        return [
          { orderId: "ord_1", customerName: "Ada" },
          { orderId: "ord_2", customerName: "Grace" },
        ]
      })
      .intoDataset(rawOrdersDataset)

    const syncRunsStorage = createSyncRunStorage()
    const runtime = createRuntime({
      sync,
      syncRunsStorage,
      lakeStorage: wrappedLakeStorage,
    })
    const finishedRuns: SyncRunRecord[] = []

    const result = await runSyncJob({
      runtime,
      job: {
        id: "run_1",
        syncId: "sync-orders",
      },
      onRunFinished(run) {
        finishedRuns.push(run)
      },
    })

    expect(calls).toEqual(["create:raw.erp.orders", "begin:raw.erp.orders"])
    expect(seenContext?.projectId).toBe("project-1")
    expect(seenContext?.syncId).toBe("sync-orders")
    expect(seenContext?.signal).toBeInstanceOf(AbortSignal)
    expect(result.rowsRead).toBe(2)
    expect(result.version!.producer).toEqual({
      kind: "sync",
      id: "sync-orders",
      runId: "run_1",
    })

    const run = await syncRunsStorage.getById({
      projectId: "project-1",
      id: "run_1",
    })
    expect(run).toMatchObject({
      id: "run_1",
      projectId: "project-1",
      syncId: "sync-orders",
      datasetId: "raw.erp.orders",
      mode: "snapshot",
      status: "succeeded",
      rowsRead: 2,
      output: {
        datasetId: "raw.erp.orders",
        versionId: result.version!.versionId,
      },
    })
    if (!run) throw new Error("Expected the sync run to be persisted.")
    expect(finishedRuns).toEqual([run])

    const rows = await collectRows(runtime.lakeStorage.readRows({ datasetId: "raw.erp.orders" }))
    expect(rows).toEqual([
      { orderId: "ord_1", customerName: "Ada" },
      { orderId: "ord_2", customerName: "Grace" },
    ])
  })

  test("supports single-row, iterable, and async iterable read results", async () => {
    const syncSingle = defineSync("sync-single")
      .from(erpDb)
      .read(() => ({ orderId: "ord_1" }))
      .intoDataset(rawSingleDataset)
    const singleResult = await runSyncJob({
      runtime: createRuntime({ sync: syncSingle }),
      job: {
        id: "run_single",
        syncId: "sync-single",
      },
    })

    expect(singleResult.rowsRead).toBe(1)

    const syncIterable = defineSync("sync-iterable")
      .from(erpDb)
      .read(() => [{ orderId: "ord_2" }, { orderId: "ord_3" }])
      .intoDataset(rawIterableDataset)
    const iterableResult = await runSyncJob({
      runtime: createRuntime({ sync: syncIterable }),
      job: {
        id: "run_iterable",
        syncId: "sync-iterable",
      },
    })

    expect(iterableResult.rowsRead).toBe(2)

    const syncAsync = defineSync("sync-async")
      .from(erpDb)
      .read(async function* () {
        yield { orderId: "ord_4" }
        yield { orderId: "ord_5" }
      })
      .intoDataset(rawAsyncDataset)
    const asyncResult = await runSyncJob({
      runtime: createRuntime({ sync: syncAsync }),
      job: {
        id: "run_async",
        syncId: "sync-async",
      },
    })

    expect(asyncResult.rowsRead).toBe(2)
  })

  test("passes the latest successful checkpoint and stores the next checkpoint", async () => {
    const syncRunsStorage = createSyncRunStorage()
    await startSyncRun(syncRunsStorage, {
      id: "run_previous",
      projectId: "project-1",
      syncId: "sync-orders",
      datasetId: "raw.erp.orders",
      mode: "append",
      startedAt: new Date("2026-04-06T15:00:00.000Z"),
    })
    await syncRunsStorage.finish({
      id: "run_previous",
      projectId: "project-1",
      status: "succeeded",
      finishedAt: new Date("2026-04-06T15:00:01.000Z"),
      rowsRead: 1,
      output: {
        datasetId: "raw.erp.orders",
        versionId: "ver_previous",
      },
      checkpoint: { cursor: "cursor-1" },
    })
    await startSyncRun(syncRunsStorage, {
      id: "run_running",
      projectId: "project-1",
      syncId: "sync-orders",
      datasetId: "raw.erp.orders",
      mode: "append",
      startedAt: new Date("2026-04-06T16:00:00.000Z"),
    })

    let seenCheckpoint: { cursor: string } | undefined
    const sync = defineSync("sync-orders", { mode: "append" })
      .checkpoint<{ cursor: string }>()
      .from(erpDb)
      .read((_client, context) => {
        seenCheckpoint = context.checkpoint
        context.setCheckpoint({ cursor: "cursor-2" })
        return [{ orderId: "ord_1" }]
      })
      .intoDataset(rawOrdersDataset)

    await runSyncJob({
      runtime: createRuntime({
        sync,
        syncRunsStorage,
      }),
      job: {
        id: "run_1",
        syncId: "sync-orders",
      },
    })

    const run = await syncRunsStorage.getById({
      projectId: "project-1",
      id: "run_1",
    })
    expect(seenCheckpoint).toEqual({ cursor: "cursor-1" })
    expect(run?.checkpoint).toEqual({ cursor: "cursor-2" })
  })

  test("streams ordered merge changes and stores the successful checkpoint", async () => {
    const lakeStorage = new InMemoryLakeStorage()
    const syncRunsStorage = createSyncRunStorage()
    const sync = defineSync("sync-keyed-orders", { mode: "merge" })
      .checkpoint<{ cursor: string }>()
      .from(erpDb)
      .read(async function* (_client, context) {
        yield change.upsert({ orderId: "ord_1", status: "open" })
        context.setCheckpoint({ cursor: "event-1" })
        yield change.delete({ orderId: "missing" })
        context.setCheckpoint({ cursor: "event-2" })
      })
      .intoDataset(keyedOrdersDataset)

    const result = await runSyncJob({
      runtime: createRuntime({ sync, syncRunsStorage, lakeStorage }),
      job: { id: "run_merge", syncId: sync.id },
    })

    expect(result).toMatchObject({
      mode: "merge",
      rowsRead: 2,
      versionCreated: true,
      version: {
        mode: "merge",
        rowCount: 1,
        producer: { kind: "sync", id: sync.id, runId: "run_merge" },
      },
    })
    expect(await collectRows(lakeStorage.readRows({ datasetId: keyedOrdersDataset.id }))).toEqual([
      { orderId: "ord_1", status: "open" },
    ])
    expect(
      await syncRunsStorage.getById({ projectId: "project-1", id: "run_merge" })
    ).toMatchObject({
      mode: "merge",
      status: "succeeded",
      rowsRead: 2,
      checkpoint: { cursor: "event-2" },
    })
  })

  test("passes composite-key changes through the merge worker", async () => {
    const lakeStorage = new InMemoryLakeStorage()
    const sync = defineSync("sync-invoice-line-items", { mode: "merge" })
      .from(erpDb)
      .read(() => [
        change.upsert({ invoiceId: "inv_1", lineItemId: "line_1", status: "open" }),
        change.delete({ invoiceId: "inv_1", lineItemId: "missing" }),
      ])
      .intoDataset(keyedLineItemsDataset)

    const result = await runSyncJob({
      runtime: createRuntime({ sync, lakeStorage }),
      job: { id: "run_composite_merge", syncId: sync.id },
    })

    expect(result).toMatchObject({ rowsRead: 2, versionCreated: true })
    expect(
      await collectRows(lakeStorage.readRows({ datasetId: keyedLineItemsDataset.id }))
    ).toEqual([{ invoiceId: "inv_1", lineItemId: "line_1", status: "open" }])
  })

  test("verifies file references for merge upserts but not deletes", async () => {
    const syncRunsStorage = createSyncRunStorage()
    const sync = defineSync("sync-keyed-docs", { mode: "merge" })
      .from(erpDb)
      .read(() => [
        change.delete({ id: "doc_deleted" }),
        change.upsert({
          id: "doc_1",
          attachment: {
            blobId: "blob_missing",
            digest: "sha256:missing",
            sizeBytes: 12,
          },
        }),
      ])
      .intoDataset(keyedDocsDataset)

    await expect(
      runSyncJob({
        runtime: createRuntime({ sync, syncRunsStorage }),
        job: { id: "run_merge_missing_blob", syncId: sync.id },
      })
    ).rejects.toThrow("row 2 with dataset 'raw.keyed-docs' column 'attachment'")

    expect(
      await syncRunsStorage.getById({ projectId: "project-1", id: "run_merge_missing_blob" })
    ).toMatchObject({ status: "failed", rowsRead: 1 })
  })

  test("advances a checkpoint for an initial merge no-op without inventing a version", async () => {
    const lakeStorage = new InMemoryLakeStorage()
    const syncRunsStorage = createSyncRunStorage()
    const sync = defineSync("sync-keyed-orders", { mode: "merge" })
      .checkpoint<{ cursor: string }>()
      .from(erpDb)
      .read(function* (_client, context) {
        yield change.delete({ orderId: "missing" })
        context.setCheckpoint({ cursor: "event-1" })
      })
      .intoDataset(keyedOrdersDataset)

    const result = await runSyncJob({
      runtime: createRuntime({ sync, syncRunsStorage, lakeStorage }),
      job: { id: "run_initial_noop", syncId: sync.id },
    })

    expect(result).toMatchObject({ rowsRead: 1, versionCreated: false })
    expect(result.version).toBeUndefined()
    expect(await lakeStorage.listVersions(keyedOrdersDataset.id)).toEqual([])
    expect(
      await syncRunsStorage.getById({ projectId: "project-1", id: "run_initial_noop" })
    ).toMatchObject({
      status: "succeeded",
      rowsRead: 1,
      checkpoint: { cursor: "event-1" },
      output: undefined,
    })
  })

  test("reuses a later no-op version with a matching requested latest-version guard", async () => {
    const lakeStorage = new InMemoryLakeStorage()
    await lakeStorage.createDataset(keyedOrdersDataset)
    const seed = await lakeStorage.beginMerge({ dataset: keyedOrdersDataset })
    await seed.writeChanges([change.upsert({ orderId: "ord_1", status: "open" })])
    const seedResult = await seed.commit()
    if (!seedResult.version) throw new Error("Expected a seed version")

    const sync = defineSync("sync-keyed-orders", { mode: "merge" })
      .from(erpDb)
      .read(() => [change.upsert({ orderId: "ord_1", status: "open" })])
      .intoDataset(keyedOrdersDataset)
    const result = await runSyncJob({
      runtime: createRuntime({ sync, lakeStorage }),
      job: {
        id: "run_later_noop",
        syncId: sync.id,
        expectedLatestVersionId: seedResult.version.versionId,
      },
    })

    expect(result).toMatchObject({
      rowsRead: 1,
      versionCreated: false,
      version: { versionId: seedResult.version.versionId },
    })
    expect(await lakeStorage.listVersions(keyedOrdersDataset.id)).toHaveLength(1)
  })

  test("rejects a stale requested merge version before connecting to the source", async () => {
    const lakeStorage = new InMemoryLakeStorage()
    const syncRunsStorage = createSyncRunStorage()
    await lakeStorage.createDataset(keyedOrdersDataset)
    const seed = await lakeStorage.beginMerge({ dataset: keyedOrdersDataset })
    await seed.writeChanges([change.upsert({ orderId: "ord_1", status: "open" })])
    await seed.commit()

    let connectorCalls = 0
    let readCalls = 0
    const sync = defineSync("sync-keyed-orders", { mode: "merge" })
      .from(erpDb)
      .read(() => {
        readCalls += 1
        return [change.upsert({ orderId: "ord_2", status: "open" })]
      })
      .intoDataset(keyedOrdersDataset)

    await expect(
      runSyncJob({
        runtime: createRuntime({
          sync,
          syncRunsStorage,
          lakeStorage,
          onConnect() {
            connectorCalls += 1
          },
        }),
        job: {
          id: "run_stale_request",
          syncId: sync.id,
          expectedLatestVersionId: "stale-version",
        },
      })
    ).rejects.toThrow("Optimistic merge start failed")

    expect(connectorCalls).toBe(0)
    expect(readCalls).toBe(0)
    expect(
      await syncRunsStorage.getById({ projectId: "project-1", id: "run_stale_request" })
    ).toMatchObject({ status: "failed", rowsRead: 0 })
    expect(await lakeStorage.listVersions(keyedOrdersDataset.id)).toHaveLength(1)
  })

  test("does not store a checkpoint when a concurrent merge makes the session stale", async () => {
    const lakeStorage = new InMemoryLakeStorage()
    const syncRunsStorage = createSyncRunStorage()
    const sync = defineSync("sync-keyed-orders", { mode: "merge" })
      .checkpoint<{ cursor: string }>()
      .from(erpDb)
      .read(async function* (_client, context) {
        yield change.upsert({ orderId: "ord_worker", status: "open" })
        context.setCheckpoint({ cursor: "event-1" })

        const concurrent = await lakeStorage.beginMerge({ dataset: keyedOrdersDataset })
        await concurrent.writeChanges([
          change.upsert({ orderId: "ord_concurrent", status: "paid" }),
        ])
        await concurrent.commit()
      })
      .intoDataset(keyedOrdersDataset)

    await expect(
      runSyncJob({
        runtime: createRuntime({ sync, syncRunsStorage, lakeStorage }),
        job: { id: "run_stale", syncId: sync.id },
      })
    ).rejects.toThrow("Optimistic merge commit failed")

    const run = await syncRunsStorage.getById({ projectId: "project-1", id: "run_stale" })
    expect(run).toMatchObject({ status: "failed", rowsRead: 1 })
    expect(run?.checkpoint).toBeUndefined()
    expect(await collectRows(lakeStorage.readRows({ datasetId: keyedOrdersDataset.id }))).toEqual([
      { orderId: "ord_concurrent", status: "paid" },
    ])
  })

  test("cancels and discards an in-flight merge", async () => {
    const controller = new AbortController()
    const lakeStorage = new InMemoryLakeStorage()
    const syncRunsStorage = createSyncRunStorage()
    const sync = defineSync("sync-keyed-orders", { mode: "merge" })
      .from(erpDb)
      .read(async function* () {
        yield change.upsert({ orderId: "ord_1", status: "open" })
        controller.abort()
        yield change.upsert({ orderId: "ord_2", status: "open" })
      })
      .intoDataset(keyedOrdersDataset)

    await expect(
      runSyncJob({
        runtime: createRuntime({ sync, syncRunsStorage, lakeStorage }),
        job: { id: "run_cancelled_merge", syncId: sync.id },
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" })

    expect(
      await syncRunsStorage.getById({ projectId: "project-1", id: "run_cancelled_merge" })
    ).toMatchObject({ status: "cancelled", rowsRead: 1 })
    expect(await lakeStorage.listVersions(keyedOrdersDataset.id)).toEqual([])
  })

  test("succeeds and advances the checkpoint for a first empty append", async () => {
    const syncRunsStorage = createSyncRunStorage()
    const sync = defineSync("sync-orders", { mode: "append" })
      .checkpoint<{ cursor: string }>()
      .from(erpDb)
      .read((_client, context) => {
        context.setCheckpoint({ cursor: "cursor-1" })
        return []
      })
      .intoDataset(rawOrdersDataset)
    const runtime = createRuntime({ sync, syncRunsStorage })

    const result = await runSyncJob({
      runtime,
      job: { id: "run_empty", syncId: "sync-orders" },
    })

    expect(result).toMatchObject({
      rowsRead: 0,
      versionCreated: false,
    })
    expect(result.version).toBeUndefined()
    expect(await runtime.lakeStorage.getLatestVersion(rawOrdersDataset.id)).toBeNull()
    expect(
      await syncRunsStorage.getById({ projectId: "project-1", id: "run_empty" })
    ).toMatchObject({
      status: "succeeded",
      rowsRead: 0,
      checkpoint: { cursor: "cursor-1" },
    })
  })

  test("succeeds without committing a first empty snapshot", async () => {
    const syncRunsStorage = createSyncRunStorage()
    const lakeStorage = new RejectingFirstEmptyCommitLakeStorage()
    const sync = defineSync("sync-empty-orders")
      .from(erpDb)
      .read(() => [])
      .intoDataset(rawOrdersDataset)
    const runtime = createRuntime({ sync, syncRunsStorage, lakeStorage })

    const result = await runSyncJob({
      runtime,
      job: { id: "run_empty_snapshot", syncId: sync.id },
    })

    expect(result).toMatchObject({
      mode: "snapshot",
      rowsRead: 0,
      versionCreated: false,
    })
    expect(result.version).toBeUndefined()
    expect(await lakeStorage.getLatestVersion(rawOrdersDataset.id)).toBeNull()
    expect(
      await syncRunsStorage.getById({ projectId: "project-1", id: "run_empty_snapshot" })
    ).toMatchObject({
      status: "succeeded",
      rowsRead: 0,
      output: undefined,
    })
  })

  test("commits an empty snapshot when it must clear a previous version", async () => {
    const lakeStorage = new RejectingFirstEmptyCommitLakeStorage()
    await lakeStorage.createDataset(rawOrdersDataset)
    const seed = await lakeStorage.beginWrite({ dataset: rawOrdersDataset, mode: "snapshot" })
    await seed.writeRows([{ orderId: "ord_1" }])
    const previous = await seed.commit()

    const sync = defineSync("sync-clear-orders")
      .from(erpDb)
      .read(() => [])
      .intoDataset(rawOrdersDataset)
    const runtime = createRuntime({ sync, lakeStorage })

    const result = await runSyncJob({
      runtime,
      job: { id: "run_clear_snapshot", syncId: sync.id },
    })

    expect(result.versionCreated).toBe(true)
    expect(result.version?.versionId).not.toBe(previous.versionId)
    expect(result.version?.rowCount).toBe(0)
    expect(await collectRows(lakeStorage.readRows({ datasetId: rawOrdersDataset.id }))).toEqual([])
  })

  test("does not advance checkpoints from failed runs", async () => {
    const syncRunsStorage = createSyncRunStorage()
    await startSyncRun(syncRunsStorage, {
      id: "run_previous",
      projectId: "project-1",
      syncId: "sync-orders",
      datasetId: "raw.erp.orders",
      mode: "append",
      startedAt: new Date("2026-04-06T15:00:00.000Z"),
    })
    await syncRunsStorage.finish({
      id: "run_previous",
      projectId: "project-1",
      status: "succeeded",
      finishedAt: new Date("2026-04-06T15:00:01.000Z"),
      rowsRead: 1,
      output: {
        datasetId: "raw.erp.orders",
        versionId: "ver_previous",
      },
      checkpoint: { cursor: "cursor-1" },
    })

    let shouldFail = true
    const seenCheckpoints: Array<{ cursor: string } | undefined> = []
    const sync = defineSync("sync-orders", { mode: "append" })
      .checkpoint<{ cursor: string }>()
      .from(erpDb)
      .read((_client, context) => {
        seenCheckpoints.push(context.checkpoint ? structuredClone(context.checkpoint) : undefined)
        if (shouldFail) {
          context.setCheckpoint({ cursor: "cursor-bad" })
          return [42]
        }

        context.setCheckpoint({ cursor: "cursor-2" })
        return [{ orderId: "ord_1" }]
      })
      .intoDataset(rawOrdersDataset)

    await expect(
      runSyncJob({
        runtime: createRuntime({
          sync,
          syncRunsStorage,
        }),
        job: {
          id: "run_failed",
          syncId: "sync-orders",
        },
      })
    ).rejects.toThrow("returned an invalid row")

    const failedRun = await syncRunsStorage.getById({
      projectId: "project-1",
      id: "run_failed",
    })
    expect(failedRun?.checkpoint).toBeUndefined()

    shouldFail = false
    await runSyncJob({
      runtime: createRuntime({
        sync,
        syncRunsStorage,
      }),
      job: {
        id: "run_succeeded",
        syncId: "sync-orders",
      },
    })

    const succeededRun = await syncRunsStorage.getById({
      projectId: "project-1",
      id: "run_succeeded",
    })
    expect(seenCheckpoints).toEqual([{ cursor: "cursor-1" }, { cursor: "cursor-1" }])
    expect(succeededRun?.checkpoint).toEqual({ cursor: "cursor-2" })
  })

  test("rejects non-JSON checkpoint values", async () => {
    const syncRunsStorage = createSyncRunStorage()
    const sync = defineSync("sync-orders", { mode: "append" })
      .checkpoint<unknown>()
      .from(erpDb)
      .read((_client, context) => {
        context.setCheckpoint(new Date("2026-04-06T15:00:00.000Z"))
        return [{ orderId: "ord_1" }]
      })
      .intoDataset(rawOrdersDataset)

    await expect(
      runSyncJob({
        runtime: createRuntime({
          sync,
          syncRunsStorage,
        }),
        job: {
          id: "run_1",
          syncId: "sync-orders",
        },
      })
    ).rejects.toThrow("checkpoint must be a JSON value")

    const run = await syncRunsStorage.getById({
      projectId: "project-1",
      id: "run_1",
    })
    expect(run).toMatchObject({
      status: "failed",
      rowsRead: 0,
    })
    expect(run?.checkpoint).toBeUndefined()
  })

  test("writes the running record before connector execution", async () => {
    const syncRunsStorage = createSyncRunStorage()
    let seenStatus: string | undefined

    const sync = defineSync("sync-orders")
      .from(erpDb)
      .read(() => [])
      .intoDataset(rawOrdersDataset)

    const runtime = createRuntime({
      sync,
      syncRunsStorage,
      onConnect: async () => {
        seenStatus = (
          await syncRunsStorage.getById({
            projectId: "project-1",
            id: "run_1",
          })
        )?.status
      },
    })

    await runSyncJob({
      runtime,
      job: {
        id: "run_1",
        syncId: "sync-orders",
      },
    })

    expect(seenStatus).toBe("running")
  })

  test("marks the run failed and aborts the write when a row is invalid", async () => {
    const syncRunsStorage = createSyncRunStorage()
    const lakeStorage = new InMemoryLakeStorage()
    let abortCalls = 0

    const wrappedLakeStorage: LakeStorage = {
      assertDatasetDefinitionsCompatible(definitions) {
        return lakeStorage.assertDatasetDefinitionsCompatible(definitions)
      },
      createDataset(definition) {
        return lakeStorage.createDataset(definition)
      },
      getDataset(datasetId) {
        return lakeStorage.getDataset(datasetId)
      },
      listDatasets() {
        return lakeStorage.listDatasets()
      },
      listDatasetCatalogState(datasetIds) {
        return lakeStorage.listDatasetCatalogState(datasetIds)
      },
      listVersions(datasetId, limit) {
        return lakeStorage.listVersions(datasetId, limit)
      },
      async beginWrite(input) {
        const write = await lakeStorage.beginWrite(input)
        const wrappedWrite: LakeWriteSession = {
          writeRows(rows) {
            return write.writeRows(rows)
          },
          commit(commitInput) {
            return write.commit(commitInput)
          },
          async abort() {
            abortCalls += 1
            await write.abort()
          },
        }
        return wrappedWrite
      },
      beginMerge(input) {
        return lakeStorage.beginMerge(input)
      },
      getLatestVersion(datasetId) {
        return lakeStorage.getLatestVersion(datasetId)
      },
      getVersion(datasetId, versionId) {
        return lakeStorage.getVersion(datasetId, versionId)
      },
      readRows(input) {
        return lakeStorage.readRows(input)
      },
    }

    const sync = defineSync("sync-orders")
      .from(erpDb)
      .read(() => [{ orderId: "ord_1" }, 42])
      .intoDataset(rawOrdersDataset)

    await expect(
      runSyncJob({
        runtime: createRuntime({
          sync,
          syncRunsStorage,
          lakeStorage: wrappedLakeStorage,
        }),
        job: {
          id: "run_1",
          syncId: "sync-orders",
        },
      })
    ).rejects.toThrow("returned an invalid row at item 2")

    expect(abortCalls).toBe(1)

    const run = await syncRunsStorage.getById({
      projectId: "project-1",
      id: "run_1",
    })
    expect(run).toMatchObject({
      status: "failed",
      rowsRead: 1,
      error: {
        code: "sync.execution_failed",
        message: "Sync execution failed.",
        retryable: false,
        at: expect.any(String),
        details: {
          syncId: "sync-orders",
          runId: "run_1",
          datasetId: "raw.erp.orders",
        },
      },
    })
  })

  test("rejects unsupported top-level read results", async () => {
    const syncRunsStorage = createSyncRunStorage()
    const sync = defineSync("sync-orders")
      .from(erpDb)
      .read(() => 42)
      .intoDataset(rawOrdersDataset)

    await expect(
      runSyncJob({
        runtime: createRuntime({
          sync,
          syncRunsStorage,
        }),
        job: {
          id: "run_1",
          syncId: "sync-orders",
        },
      })
    ).rejects.toThrow("returned an unsupported read result")

    const run = await syncRunsStorage.getById({
      projectId: "project-1",
      id: "run_1",
    })
    expect(run).toMatchObject({
      status: "failed",
      rowsRead: 0,
      error: {
        code: "sync.execution_failed",
        message: "Sync execution failed.",
        retryable: false,
        at: expect.any(String),
        details: {
          syncId: "sync-orders",
          runId: "run_1",
          datasetId: "raw.erp.orders",
        },
      },
    })
  })

  test("marks the run failed when a row does not match the dataset schema", async () => {
    const syncRunsStorage = createSyncRunStorage()
    const sync = defineSync("sync-orders")
      .from(erpDb)
      .read(() => [{ customerName: "Ada", unexpected: true }])
      .intoDataset(rawOrdersDataset)

    await expect(
      runSyncJob({
        runtime: createRuntime({
          sync,
          syncRunsStorage,
        }),
        job: {
          id: "run_schema_error",
          syncId: "sync-orders",
        },
      })
    ).rejects.toThrow("unknown column 'unexpected'")

    const run = await syncRunsStorage.getById({
      projectId: "project-1",
      id: "run_schema_error",
    })
    expect(run).toMatchObject({
      status: "failed",
      rowsRead: 0,
      error: {
        code: "sync.execution_failed",
        message: "Sync execution failed.",
        retryable: false,
        at: expect.any(String),
        details: {
          syncId: "sync-orders",
          runId: "run_schema_error",
          datasetId: "raw.erp.orders",
        },
      },
    })
  })

  test("marks the run failed when a fileRef references a missing blob", async () => {
    const syncRunsStorage = createSyncRunStorage()
    const sync = defineSync("sync-docs")
      .from(erpDb)
      .read(() => [
        {
          id: "doc_1",
          attachment: {
            blobId: "blob_missing",
            digest: "sha256:missing",
            sizeBytes: 12,
          },
        },
      ])
      .intoDataset(rawDocsDataset)

    await expect(
      runSyncJob({
        runtime: createRuntime({
          sync,
          syncRunsStorage,
        }),
        job: {
          id: "run_missing_blob",
          syncId: "sync-docs",
        },
      })
    ).rejects.toThrow("referencing unknown blob 'blob_missing'")

    const run = await syncRunsStorage.getById({
      projectId: "project-1",
      id: "run_missing_blob",
    })
    expect(run).toMatchObject({
      status: "failed",
      rowsRead: 0,
      error: {
        code: "sync.execution_failed",
        message: "Sync execution failed.",
        retryable: false,
        at: expect.any(String),
        details: {
          syncId: "sync-docs",
          runId: "run_missing_blob",
          datasetId: "raw.docs",
        },
      },
    })
  })

  test("lets sync read handlers store blobs and return validated fileRefs", async () => {
    const syncRunsStorage = createSyncRunStorage()
    const blobStorage = new InMemoryBlobStorage()
    const body = new TextEncoder().encode("hello from a synced document")
    let storedFileRef: FileRef | undefined

    const sync = defineSync("sync-docs")
      .from(erpDb)
      .read(async (_client, context) => {
        const fileRef = await context.blobs.put({
          body,
          fileName: "hello.txt",
          mediaType: "text/plain",
          logicalPath: "docs/hello.txt",
        })
        storedFileRef = fileRef

        return [{ id: "doc_1", attachment: fileRef }]
      })
      .intoDataset(rawDocsDataset)

    const runtime = createRuntime({
      sync,
      syncRunsStorage,
      blobStorage,
    })

    const result = await runSyncJob({
      runtime,
      job: {
        id: "run_blob_ingestion",
        syncId: "sync-docs",
      },
    })

    expect(result.rowsRead).toBe(1)
    expect(storedFileRef).toBeDefined()

    const fileRef = storedFileRef!
    await expect(blobStorage.stat(fileRef.blobId)).resolves.toEqual({
      blobId: fileRef.blobId,
      digest: fileRef.digest,
      sizeBytes: fileRef.sizeBytes,
    })

    const rows = await collectRows(runtime.lakeStorage.readRows({ datasetId: rawDocsDataset.id }))
    expect(rows).toEqual([{ id: "doc_1", attachment: fileRef }])

    const run = await syncRunsStorage.getById({
      projectId: "project-1",
      id: "run_blob_ingestion",
    })
    expect(run).toMatchObject({
      status: "succeeded",
      rowsRead: 1,
      output: {
        datasetId: "raw.docs",
        versionId: result.version!.versionId,
      },
    })
  })

  test("marks the run cancelled when the signal aborts during iteration", async () => {
    const controller = new AbortController()
    const syncRunsStorage = createSyncRunStorage()

    const sync = defineSync("sync-orders")
      .from(erpDb)
      .read(async function* () {
        yield { orderId: "ord_1" }
        controller.abort()
        yield { orderId: "ord_2" }
      })
      .intoDataset(rawOrdersDataset)

    await expect(
      runSyncJob({
        runtime: createRuntime({
          sync,
          syncRunsStorage,
        }),
        job: {
          id: "run_1",
          syncId: "sync-orders",
        },
        signal: controller.signal,
      })
    ).rejects.toThrow()

    const run = await syncRunsStorage.getById({
      projectId: "project-1",
      id: "run_1",
    })
    expect(run).toMatchObject({
      status: "cancelled",
      rowsRead: 1,
      error: {
        code: "runtime.cancelled",
        retryable: false,
        at: expect.any(String),
        details: { syncId: "sync-orders", runId: "run_1" },
      },
    })
  })

  test("forwards optimistic commit expectations and keeps rowsRead distinct from version rowCount", async () => {
    const lakeStorage = new InMemoryLakeStorage()
    await lakeStorage.createDataset(rawOrdersDataset)

    const seedWrite = await lakeStorage.beginWrite({
      dataset: rawOrdersDataset,
      mode: "snapshot",
    })
    await seedWrite.writeRows([{ orderId: "existing" }])
    const initialVersion = await seedWrite.commit()

    const sync = defineSync("sync-orders", { mode: "append" })
      .from(erpDb)
      .read(() => [{ orderId: "ord_1" }, { orderId: "ord_2" }])
      .intoDataset(rawOrdersDataset)

    const result = await runSyncJob({
      runtime: createRuntime({
        sync,
        lakeStorage,
      }),
      job: {
        id: "run_1",
        syncId: "sync-orders",
        expectedLatestVersionId: initialVersion.versionId,
      },
    })

    expect(result.rowsRead).toBe(2)
    expect(result.version!.rowCount).toBe(3)
    expect(result.version!.parentVersionId).toBe(initialVersion.versionId)
  })

  test("surfaces bookkeeping failures after the lake commit clearly", async () => {
    const delegate = createSyncRunStorage()
    const syncRunsStorage: SyncRunStorage = {
      queue(input) {
        return delegate.queue(input)
      },
      start(input) {
        return delegate.start(input)
      },
      finish(input) {
        if (input.status === "succeeded") {
          throw new Error("finish exploded")
        }

        return delegate.finish(input)
      },
      getById(params) {
        return delegate.getById(params)
      },
      list(input) {
        return delegate.list(input)
      },
      listLatestBySyncIds(input) {
        return delegate.listLatestBySyncIds(input)
      },
    }
    registerSyncRunStorage(syncRunsStorage, executionsByRunStorage.get(delegate)!)

    const lakeStorage = new InMemoryLakeStorage()
    const finishedRuns: SyncRunRecord[] = []
    const sync = defineSync("sync-orders")
      .from(erpDb)
      .read(() => [{ orderId: "ord_1" }])
      .intoDataset(rawOrdersDataset)

    await expect(
      runSyncJob({
        runtime: createRuntime({
          sync,
          syncRunsStorage,
          lakeStorage,
        }),
        job: {
          id: "run_1",
          syncId: "sync-orders",
        },
        onRunFinished(run) {
          finishedRuns.push(run)
        },
      })
    ).rejects.toMatchObject({
      code: "internal.unexpected",
      message: expect.stringContaining("dataset commit may already have succeeded"),
      details: {
        syncId: "sync-orders",
        runId: "run_1",
        datasetId: "raw.erp.orders",
        versionId: expect.any(String),
      },
    })

    const latestVersion = await lakeStorage.getLatestVersion("raw.erp.orders")
    expect(latestVersion?.producer).toEqual({
      kind: "sync",
      id: "sync-orders",
      runId: "run_1",
    })

    const run = await delegate.getById({
      projectId: "project-1",
      id: "run_1",
    })
    expect(run?.status).toBe("running")
    expect(finishedRuns).toHaveLength(0)
  })

  test("works against LocalLakeStorage", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "sixb-sync-worker-"))
    tempDirs.push(rootDir)

    const lakeStorage = new LocalLakeStorage({ path: rootDir })
    const syncRunsStorage = createSyncRunStorage()
    const sync = defineSync("sync-orders")
      .from(erpDb)
      .read(() => [
        { orderId: "ord_1", customerName: "Ada" },
        { orderId: "ord_2", customerName: "Grace" },
      ])
      .intoDataset(rawOrdersDataset)

    const result = await runSyncJob({
      runtime: createRuntime({
        sync,
        syncRunsStorage,
        lakeStorage,
      }),
      job: {
        id: "run_1",
        syncId: "sync-orders",
      },
    })

    const rows = await collectRows(lakeStorage.readRows({ datasetId: "raw.erp.orders" }))
    expect(result.version!.rowCount).toBe(2)
    expect(rows).toEqual([
      { orderId: "ord_1", customerName: "Ada" },
      { orderId: "ord_2", customerName: "Grace" },
    ])
  })

  test("runs a merge end-to-end against LocalLakeStorage", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "sixb-sync-worker-merge-"))
    tempDirs.push(rootDir)

    const lakeStorage = new LocalLakeStorage({ path: rootDir })
    const sync = defineSync("sync-keyed-orders", { mode: "merge" })
      .from(erpDb)
      .read(() => [
        change.upsert({ orderId: "ord_1", status: "open" }),
        change.upsert({ orderId: "ord_2", status: "paid" }),
        change.delete({ orderId: "ord_1" }),
      ])
      .intoDataset(keyedOrdersDataset)

    const result = await runSyncJob({
      runtime: createRuntime({ sync, lakeStorage }),
      job: { id: "run_local_merge", syncId: sync.id },
    })

    expect(result).toMatchObject({
      mode: "merge",
      rowsRead: 3,
      versionCreated: true,
      version: { mode: "merge", rowCount: 1 },
    })
    expect(await collectRows(lakeStorage.readRows({ datasetId: keyedOrdersDataset.id }))).toEqual([
      { orderId: "ord_2", status: "paid" },
    ])
  })

  test("preserves heterogeneous row shapes when committing to lake storage", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "sixb-sync-worker-"))
    tempDirs.push(rootDir)

    const lakeStorage = new LocalLakeStorage({ path: rootDir })
    const syncRunsStorage = createSyncRunStorage()
    const expectedRows: DatasetRow[] = [
      {
        orderId: "ord_1",
        customerName: "Ada",
        status: "paid",
      },
      {
        orderId: "ord_2",
        total: 42.5,
        discountCode: "SPRING",
      },
      {
        orderId: "ord_3",
        metadata: {
          source: "erp",
          priority: 2,
        },
        tags: ["vip", "expedited"],
      },
    ]

    const sync = defineSync("sync-orders")
      .from(erpDb)
      .read(() => expectedRows)
      .intoDataset(rawOrdersDataset)

    const result = await runSyncJob({
      runtime: createRuntime({
        sync,
        syncRunsStorage,
        lakeStorage,
      }),
      job: {
        id: "run_heterogeneous",
        syncId: "sync-orders",
      },
    })

    const rows = await collectRows(lakeStorage.readRows({ datasetId: "raw.erp.orders" }))

    expect(result.rowsRead).toBe(3)
    expect(result.version!.rowCount).toBe(3)
    expect(rows).toEqual(expectedRows)
  })
})
