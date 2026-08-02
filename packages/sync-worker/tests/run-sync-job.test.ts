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
  col,
  defineConnector,
  defineDataset,
  defineSync,
  InMemoryBlobStorage,
  InMemoryLakeStorage,
  InMemoryStorage,
} from "@sixb/core"
import type { LakeWriteSession } from "@sixb/core/lake-storage"
import type { SyncRunStorage } from "@sixb/core/storage"
import { InMemorySyncRunStorage } from "@sixb/core/storage"
import { LocalLakeStorage } from "@sixb/lake-local"
import { runSyncJob } from "../src/run-sync-job"
import type { SyncWorkerContext } from "../src/types"

const tempDirs: string[] = []

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
const rawDocsDataset = defineDataset("raw.docs", {
  schema: [col("id", "string"), col("attachment", "fileRef", { nullable: true })],
})

function createRuntime(options: {
  sync: SyncDefinition
  syncRunsStorage?: SyncRunStorage
  lakeStorage?: LakeStorage
  blobStorage?: BlobStorage
  client?: unknown
  onConnect?: () => Promise<void> | void
}): SyncWorkerContext {
  const syncRunsStorage = options.syncRunsStorage ?? new InMemorySyncRunStorage()
  const lakeStorage = options.lakeStorage ?? new InMemoryLakeStorage()
  const blobStorage = options.blobStorage ?? new InMemoryBlobStorage()
  const client = options.client ?? {}

  return {
    id: "project-1",
    syncRunsStorage,
    lakeStorage,
    blobStorage,
    getDatasetById(datasetId: string) {
      return datasetId === options.sync.target.dataset.id ? options.sync.target.dataset : null
    },
    getSyncById(syncId: string) {
      return syncId === options.sync.id ? options.sync : null
    },
    async connector<TAdapter extends ConnectorAdapter>(
      _definition: ConnectorDefinition<string, TAdapter>
    ): Promise<ConnectorClient<TAdapter>> {
      await options.onConnect?.()
      return client as ConnectorClient<TAdapter>
    },
  }
}

async function collectRows(rows: AsyncIterable<DatasetRow>): Promise<DatasetRow[]> {
  const result: DatasetRow[] = []
  for await (const row of rows) {
    result.push(row)
  }
  return result
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

    const syncRunsStorage = new InMemorySyncRunStorage()
    const runtime = createRuntime({
      sync,
      syncRunsStorage,
      lakeStorage: wrappedLakeStorage,
    })

    const result = await runSyncJob({
      runtime,
      job: {
        id: "run_1",
        syncId: "sync-orders",
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
    const syncRunsStorage = new InMemorySyncRunStorage()
    await syncRunsStorage.start({
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
    await syncRunsStorage.start({
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

  test("succeeds and advances the checkpoint for a first empty append", async () => {
    const syncRunsStorage = new InMemorySyncRunStorage()
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

  test("does not advance checkpoints from failed runs", async () => {
    const syncRunsStorage = new InMemorySyncRunStorage()
    await syncRunsStorage.start({
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
    const syncRunsStorage = new InMemorySyncRunStorage()
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
    const syncRunsStorage = new InMemorySyncRunStorage()
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
    const syncRunsStorage = new InMemorySyncRunStorage()
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
        code: "sync.failed",
        message:
          "[SixbSyncWorker] Sync 'sync-orders' returned an invalid row at item 2. Dataset rows must be plain objects.",
      },
    })
  })

  test("rejects unsupported top-level read results", async () => {
    const syncRunsStorage = new InMemorySyncRunStorage()
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
        code: "sync.failed",
        message:
          "[SixbSyncWorker] Sync 'sync-orders' returned an unsupported read result. Expected a row object, iterable, or async iterable.",
      },
    })
  })

  test("marks the run failed when a row does not match the dataset schema", async () => {
    const syncRunsStorage = new InMemorySyncRunStorage()
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
        code: "sync.failed",
        message:
          "[SixbSyncWorker] Sync 'sync-orders' returned an invalid row at item 1. Dataset 'raw.erp.orders' row contains unknown column 'unexpected'.",
      },
    })
  })

  test("marks the run failed when a fileRef references a missing blob", async () => {
    const syncRunsStorage = new InMemorySyncRunStorage()
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
        code: "sync.failed",
        message:
          "[SixbSyncWorker] Sync 'sync-docs' returned row 1 with dataset 'raw.docs' column 'attachment' referencing unknown blob 'blob_missing'.",
      },
    })
  })

  test("lets sync read handlers store blobs and return validated fileRefs", async () => {
    const syncRunsStorage = new InMemorySyncRunStorage()
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
    const syncRunsStorage = new InMemorySyncRunStorage()

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
    const delegate = new InMemorySyncRunStorage()
    const syncRunsStorage: SyncRunStorage = {
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

    const lakeStorage = new InMemoryLakeStorage()
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
      })
    ).rejects.toThrow("dataset commit may already have succeeded")

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
  })

  test("works against LocalLakeStorage", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "sixb-sync-worker-"))
    tempDirs.push(rootDir)

    const lakeStorage = new LocalLakeStorage({ path: rootDir })
    const syncRunsStorage = new InMemoryStorage().syncRuns
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

  test("preserves heterogeneous row shapes when committing to lake storage", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "sixb-sync-worker-"))
    tempDirs.push(rootDir)

    const lakeStorage = new LocalLakeStorage({ path: rootDir })
    const syncRunsStorage = new InMemoryStorage().syncRuns
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
