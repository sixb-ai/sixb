import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { col, type DatasetDefinition, type DatasetRow, defineDataset } from "@sixb/core"
import type { DuckLakeStorage } from "../src"
import type { DuckDbExclusiveRuntime, DuckDbRuntime } from "../src/internal/duckdb-runtime"
import type { DuckLakeSnapshotReader } from "../src/internal/ducklake-snapshot-reader"
import { encodeDatasetTableName } from "../src/internal/names"
import { duckLakeMetadataTableName, quoteIdentifier, quoteSqlString } from "../src/internal/sql"
import { parseCommitMetadata, parseVersionId } from "../src/internal/versions"
import { collectRows, createLocalDuckLakeStorage, localDuckLakeOptions } from "./test-utils"

interface DuckLakeStorageInternals {
  readonly connections: {
    attachedRuntime(): Promise<DuckDbRuntime>
    withExclusiveAttached<T>(run: (runtime: DuckDbExclusiveRuntime) => Promise<T>): Promise<T>
  }
  readonly snapshotReader: {
    getLatestVersionForTableRef: DuckLakeSnapshotReader["getLatestVersionForTableRef"]
  }
}

describe("DuckLakeStorage writes and latest reads", () => {
  let rootDir: string
  let storage: DuckLakeStorage

  const ordersDataset = defineDataset("raw.erp.orders", {
    schema: [
      col("orderId", "string"),
      col("customerName", "string"),
      col("orderCount", "int64"),
      col("metadata", "json", { nullable: true }),
    ],
    description: "ERP orders",
  })

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-writes-"))
    storage = createLocalDuckLakeStorage(rootDir)
    await storage.createDataset(ordersDataset)
  })

  afterEach(async () => {
    await storage.close()
    await rm(rootDir, { recursive: true, force: true })
  })

  test("omits derived row counts for unguarded appends", async () => {
    const snapshotWrite = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "snapshot",
    })
    await snapshotWrite.writeRows([{ orderId: "ord_1", customerName: "Ada", orderCount: 1 }])
    const snapshotVersion = await snapshotWrite.commit()
    const snapshotExtraInfo = await commitExtraInfoForVersion(
      storage,
      rootDir,
      snapshotVersion.versionId
    )
    const snapshotMetadata = parseCommitMetadata(snapshotExtraInfo)
    expect(snapshotMetadata?.rowCount).toBe(1)
    expect(JSON.parse(String(snapshotExtraInfo)).sixb.rowCount).toBe(1)

    const appendWrite = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "append",
    })
    await appendWrite.writeRows([{ orderId: "ord_2", customerName: "Grace", orderCount: 2 }])
    const appendVersion = await appendWrite.commit()

    expect(appendVersion).not.toHaveProperty("rowCount")
    const latestVersion = await storage.getLatestVersion(ordersDataset.id)
    expect(latestVersion).toMatchObject({
      versionId: appendVersion.versionId,
    })
    expect(latestVersion).not.toHaveProperty("rowCount")

    const metadata = await commitMetadataForVersion(storage, rootDir, appendVersion.versionId)
    expect(metadata).toMatchObject({
      datasetId: ordersDataset.id,
      mode: "append",
    })
    expect(metadata?.rowCount).toBeUndefined()
    const appendExtraInfo = await commitExtraInfoForVersion(
      storage,
      rootDir,
      appendVersion.versionId
    )
    expect(JSON.parse(String(appendExtraInfo)).sixb).not.toHaveProperty("rowCount")
  })

  test("supports projected latest reads with limits", async () => {
    const write = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "snapshot",
    })

    await write.writeRows([
      { orderId: "ord_1", customerName: "Ada", orderCount: 1 },
      { orderId: "ord_2", customerName: "Grace", orderCount: 2 },
    ])
    const version = await write.commit()

    await expect(
      collectRows(storage.readRows({ datasetId: "raw.erp.orders", columns: ["missing"] }))
    ).rejects.toThrow("does not have column 'missing'")

    expect(
      await collectRows(
        storage.readRows({
          datasetId: "raw.erp.orders",
          columns: ["orderId"],
          limit: 1,
        })
      )
    ).toEqual([{ orderId: "ord_1" }])
    expect(
      await collectRows(
        storage.readRows({ datasetId: "raw.erp.orders", versionId: version.versionId })
      )
    ).toEqual([
      { orderId: "ord_1", customerName: "Ada", orderCount: "1", metadata: null },
      { orderId: "ord_2", customerName: "Grace", orderCount: "2", metadata: null },
    ])
  })

  test("supports breaking out of streamed reads without blocking later reads", async () => {
    const write = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "snapshot",
    })

    await write.writeRows([
      { orderId: "ord_1", customerName: "Ada", orderCount: 1 },
      { orderId: "ord_2", customerName: "Grace", orderCount: 2 },
    ])
    await write.commit()

    for await (const row of storage.readRows({ datasetId: ordersDataset.id })) {
      expect(row.orderId).toBe("ord_1")
      break
    }

    await expect(
      collectRows(storage.readRows({ datasetId: ordersDataset.id }))
    ).resolves.toHaveLength(2)
  })

  test("bounds large row streams on both the write and read paths", async () => {
    const ROW_COUNT = 5_001

    const rows = Array.from({ length: ROW_COUNT }, (_, index) => ({
      orderId: `ord_${index + 1}`,
      customerName: `Customer ${index + 1}`,
      orderCount: index + 1,
    }))

    const write = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "snapshot",
    })
    await write.writeRows(rows)
    const version = await write.commit()

    expect(version.rowCount).toBe(ROW_COUNT)

    const persisted = await collectRows(storage.readRows({ datasetId: ordersDataset.id }))
    expect(persisted).toHaveLength(ROW_COUNT)
    expect(persisted[0]).toEqual({
      orderId: "ord_1",
      customerName: "Customer 1",
      orderCount: "1",
      metadata: null,
    })
    expect(persisted[500]).toEqual({
      orderId: "ord_501",
      customerName: "Customer 501",
      orderCount: "501",
      metadata: null,
    })
    expect(persisted[ROW_COUNT - 1]).toEqual({
      orderId: `ord_${ROW_COUNT}`,
      customerName: `Customer ${ROW_COUNT}`,
      orderCount: String(ROW_COUNT),
      metadata: null,
    })

    const runtime = await (
      storage as unknown as DuckLakeStorageInternals
    ).connections.attachedRuntime()
    const originalQuery = runtime.query
    const originalOpenReader = runtime.openReader.bind(runtime)
    const rowPageQueries: string[] = []
    const streamedQueries: string[] = []
    runtime.openReader = async (sql, options) => {
      streamedQueries.push(sql)
      return originalOpenReader(sql, options)
    }
    runtime.query = (sql, values) => {
      if (sql.includes(" AT (VERSION => ")) rowPageQueries.push(sql)
      return originalQuery.call(runtime, sql, values)
    }
    try {
      await expect(
        collectRows(
          storage.readRows({
            datasetId: ordersDataset.id,
            columns: ["orderId"],
            limit: ROW_COUNT,
          })
        )
      ).resolves.toHaveLength(ROW_COUNT)
    } finally {
      runtime.query = originalQuery
      runtime.openReader = originalOpenReader
    }

    // Red check: restore the parent's row reader. It issues two eager queries; large explicit
    // limits now use one native stream with bounded conversion batches and no repeated scans.
    expect(rowPageQueries).toHaveLength(0)
    expect(streamedQueries).toHaveLength(1)
    expect(streamedQueries[0]).toContain("LIMIT 5001")
  })

  test("streams one DuckLake dataset into another without deadlocking the shared runtime", async () => {
    // Regression proof: restore DuckLakeRowReader's unbounded runtime.streamRows() path and this
    // child reaches the destination appender's first flush, then times out. Keep it isolated in a
    // child because a native stream waiting on its own runtime queue cannot be cancelled safely.
    const childRoot = await mkdtemp(join(tmpdir(), "sixb-ducklake-stream-copy-"))
    const child = Bun.spawn(
      ["bun", join(import.meta.dir, "fixtures", "stream-copy.ts"), childRoot],
      { stdout: "pipe", stderr: "pipe" }
    )
    try {
      const result = await Promise.race([
        child.exited.then((exitCode) => ({ kind: "exit" as const, exitCode })),
        Bun.sleep(20_000).then(() => ({ kind: "timeout" as const })),
      ])
      if (result.kind === "timeout") {
        child.kill()
        await child.exited
        throw new Error("DuckLake stream-to-write child timed out after 20 seconds.")
      }
      const stderr = await new Response(child.stderr).text()
      expect(result.exitCode, stderr).toBe(0)
    } finally {
      child.kill()
      await rm(childRoot, { recursive: true, force: true })
    }
  }, 30_000)

  test("appends streamed rows before reusable row objects mutate again", async () => {
    function* reusedOrderRows(): Iterable<DatasetRow> {
      const metadata: Record<string, unknown> = {
        source: "erp",
        sequence: 0,
      }
      const row: Record<string, unknown> = {
        orderId: "",
        customerName: "",
        orderCount: 0,
        metadata,
      }

      for (const values of [
        {
          orderId: "ord_1",
          customerName: "Ada",
          orderCount: 1,
          sequence: 1,
        },
        {
          orderId: "ord_2",
          customerName: "Grace",
          orderCount: 2,
          sequence: 2,
        },
        {
          orderId: "ord_3",
          customerName: "Katherine",
          orderCount: 3,
          sequence: 3,
        },
      ]) {
        const { sequence, ...rowValues } = values
        metadata.sequence = sequence
        Object.assign(row, rowValues)
        yield row
      }
    }

    const write = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "snapshot",
    })
    await write.writeRows(reusedOrderRows())
    await write.commit()

    const persisted = await collectRows(storage.readRows({ datasetId: ordersDataset.id }))
    expect(persisted).toEqual([
      {
        orderId: "ord_1",
        customerName: "Ada",
        orderCount: "1",
        metadata: { source: "erp", sequence: 1 },
      },
      {
        orderId: "ord_2",
        customerName: "Grace",
        orderCount: "2",
        metadata: { source: "erp", sequence: 2 },
      },
      {
        orderId: "ord_3",
        customerName: "Katherine",
        orderCount: "3",
        metadata: { source: "erp", sequence: 3 },
      },
    ])
  })

  test("frees the DuckDB queue for reads while a slow source is mid-write", async () => {
    let releaseSource: () => void = () => {}
    const sourceGate = new Promise<void>((resolve) => {
      releaseSource = resolve
    })
    let firstRowYielded: () => void = () => {}
    const firstRow = new Promise<void>((resolve) => {
      firstRowYielded = resolve
    })

    async function* slowOrders(): AsyncIterable<DatasetRow> {
      yield { orderId: "ord_1", customerName: "Ada", orderCount: 1 }
      firstRowYielded()
      // Simulate an external wait (API/pagination/SFTP) mid-stream.
      await sourceGate
    }

    const write = await storage.beginWrite({ dataset: ordersDataset, mode: "snapshot" })
    const writePromise = write.writeRows(slowOrders())

    await firstRow

    // The source is now parked on sourceGate. If writeRows held the appender's
    // queue slot across the external wait this read would deadlock and time
    // out; with batched staging the queue is free between batches.
    const datasets = await storage.listDatasets()
    expect(datasets.map((dataset) => dataset.id)).toContain(ordersDataset.id)

    releaseSource()
    await writePromise
    const version = await write.commit()

    expect(version.rowCount).toBe(1)
    expect(await collectRows(storage.readRows({ datasetId: ordersDataset.id }))).toEqual([
      { orderId: "ord_1", customerName: "Ada", orderCount: "1", metadata: null },
    ])
  })

  test("evolves a dataset by appending a nullable column and writes new-format rows", async () => {
    const initialDataset = defineDataset("raw.erp.schema_evolution", {
      schema: [col("invoiceId", "string"), col("total", "int64")],
    })
    const evolvedDataset = defineDataset("raw.erp.schema_evolution", {
      schema: [
        col("currency", "string", { nullable: true }),
        col("invoiceId", "string"),
        col("total", "int64"),
      ],
    })
    const storedEvolvedDataset = defineDataset("raw.erp.schema_evolution", {
      schema: [
        col("invoiceId", "string"),
        col("total", "int64"),
        col("currency", "string", { nullable: true }),
      ],
    })

    await storage.createDataset(initialDataset)

    const initialWrite = await storage.beginWrite({
      dataset: initialDataset,
      mode: "snapshot",
    })
    await initialWrite.writeRows([{ invoiceId: "inv_1", total: 100 }])
    const initialVersion = await initialWrite.commit()

    await expect(storage.createDataset(evolvedDataset)).resolves.toEqual(storedEvolvedDataset)
    await expect(storage.getDataset(initialDataset.id)).resolves.toEqual(storedEvolvedDataset)
    const schemaVersion = await storage.getLatestVersion(initialDataset.id)
    const historicalVersion = await storage.getVersion(initialDataset.id, initialVersion.versionId)

    expect(historicalVersion?.schema).toEqual(initialDataset.schema)
    expect(schemaVersion).toMatchObject({
      mode: "schema",
      parentVersionId: initialVersion.versionId,
      schema: storedEvolvedDataset.schema,
    })
    expect(schemaVersion).not.toHaveProperty("rowCount")

    const versionsAfterSchemaEvolution = await storage.listVersions(initialDataset.id)
    expect(versionsAfterSchemaEvolution).toHaveLength(2)
    expect(versionsAfterSchemaEvolution[0]).toMatchObject({
      versionId: schemaVersion?.versionId,
      mode: "schema",
      parentVersionId: initialVersion.versionId,
      schema: storedEvolvedDataset.schema,
    })
    expect(versionsAfterSchemaEvolution[0]).not.toHaveProperty("rowCount")
    expect(versionsAfterSchemaEvolution[1]).toMatchObject({
      versionId: initialVersion.versionId,
      rowCount: 1,
      schema: initialDataset.schema,
    })

    const evolvedWrite = await storage.beginWrite({
      dataset: evolvedDataset,
      mode: "append",
    })

    await evolvedWrite.writeRows([{ invoiceId: "inv_2", total: 200, currency: "EUR" }])
    const evolvedVersion = await evolvedWrite.commit()

    expect(evolvedVersion.parentVersionId).toBe(schemaVersion?.versionId)
    expect(evolvedVersion.schema).toEqual(storedEvolvedDataset.schema)
    expect(evolvedVersion).not.toHaveProperty("rowCount")
    const latestVersionAfterAppend = await storage.getLatestVersion(initialDataset.id)
    expect(latestVersionAfterAppend).toMatchObject({
      versionId: evolvedVersion.versionId,
    })
    expect(latestVersionAfterAppend).not.toHaveProperty("rowCount")
    await expect(collectRows(storage.readRows({ datasetId: initialDataset.id }))).resolves.toEqual([
      { invoiceId: "inv_1", total: "100", currency: null },
      { invoiceId: "inv_2", total: "200", currency: "EUR" },
    ])
    await expect(
      collectRows(
        storage.readRows({ datasetId: initialDataset.id, versionId: initialVersion.versionId })
      )
    ).resolves.toEqual([{ invoiceId: "inv_1", total: "100" }])
    await expect(
      collectRows(
        storage.readRows({
          datasetId: initialDataset.id,
          versionId: initialVersion.versionId,
          columns: ["currency"],
        })
      )
    ).rejects.toThrow("does not have column 'currency' at the requested version")
  })

  test("pins latest reads to the resolved version before selecting rows", async () => {
    const snapshotWrite = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "snapshot",
    })
    await snapshotWrite.writeRows([{ orderId: "ord_1", customerName: "Ada", orderCount: 1 }])
    const version1 = await snapshotWrite.commit()

    const appendWrite = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "append",
    })
    await appendWrite.writeRows([{ orderId: "ord_2", customerName: "Grace", orderCount: 2 }])
    await appendWrite.commit()

    const snapshotReader = (storage as unknown as DuckLakeStorageInternals).snapshotReader
    const getLatestVersionForTableRef =
      snapshotReader.getLatestVersionForTableRef.bind(snapshotReader)
    snapshotReader.getLatestVersionForTableRef = async () => version1

    try {
      await expect(collectRows(storage.readRows({ datasetId: ordersDataset.id }))).resolves.toEqual(
        [{ orderId: "ord_1", customerName: "Ada", orderCount: "1", metadata: null }]
      )
    } finally {
      snapshotReader.getLatestVersionForTableRef = getLatestVersionForTableRef
    }
  })

  test("rejects decimal writes that DuckDB cannot represent exactly", async () => {
    const amountsDataset = defineDataset("raw.erp.amounts", {
      schema: [col("id", "string"), col("amount", "decimal")],
    })
    await storage.createDataset(amountsDataset)

    const exactWrite = await storage.beginWrite({ dataset: amountsDataset, mode: "snapshot" })
    await exactWrite.writeRows([
      { id: "amount_1", amount: "9007199254740993.123456789" },
      { id: "amount_2", amount: "+0001.2300000000" },
    ])
    await exactWrite.commit()
    await expect(collectRows(storage.readRows({ datasetId: amountsDataset.id }))).resolves.toEqual([
      { id: "amount_1", amount: "9007199254740993.123456789" },
      { id: "amount_2", amount: "1.23" },
    ])

    const roundedWrite = await storage.beginWrite({ dataset: amountsDataset, mode: "append" })
    await expect(
      roundedWrite.writeRows([{ id: "amount_3", amount: "0.1234567891" }])
    ).rejects.toThrow("cannot be represented exactly as DECIMAL(38, 9)")
    await roundedWrite.abort()

    const overflowWrite = await storage.beginWrite({ dataset: amountsDataset, mode: "append" })
    await expect(
      overflowWrite.writeRows([{ id: "amount_4", amount: "999999999999999999999999999999" }])
    ).rejects.toThrow("cannot be represented exactly as DECIMAL(38, 9)")
    await overflowWrite.abort()
  })

  // DuckDB's appender drops the offset itself: append the raw string in `row-appender.ts` instead
  // of `normalizeDuckDbTimestampValue(value)` and e1 reads back as 09:51:02, eight hours early.
  test("preserves the UTC instant of timestamp strings with timezone offsets", async () => {
    const eventsDataset = defineDataset("raw.events.timestamps", {
      schema: [col("id", "string"), col("createdAt", "timestamp")],
    })
    await storage.createDataset(eventsDataset)

    const write = await storage.beginWrite({ dataset: eventsDataset, mode: "snapshot" })
    await write.writeRows([
      { id: "e1", createdAt: "2017-01-02T09:51:02-08:00" },
      { id: "e2", createdAt: "2017-01-02T17:51:02Z" },
      { id: "e3", createdAt: new Date("2017-01-02T17:51:02.000Z") },
    ])
    await write.commit()

    const rows = await collectRows(storage.readRows({ datasetId: eventsDataset.id }))
    expect(rows).toEqual([
      { id: "e1", createdAt: "2017-01-02T17:51:02.000Z" },
      { id: "e2", createdAt: "2017-01-02T17:51:02.000Z" },
      { id: "e3", createdAt: "2017-01-02T17:51:02.000Z" },
    ])
  })

  test("skips snapshot commits when source content is unchanged", async () => {
    const seedRows = [
      { orderId: "ord_1", customerName: "Ada", orderCount: 1 },
      {
        orderId: "ord_2",
        customerName: "Grace",
        orderCount: 2,
        metadata: { source: "erp" },
      },
    ]
    const seed = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "snapshot",
    })
    await seed.writeRows(seedRows)
    const seedVersion = await seed.commit()
    expect(seedVersion.outcome).toBe("created")
    const snapshotCountAfterSeed = await duckLakeSnapshotCount(storage, rootDir)

    const identical = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "snapshot",
    })
    await identical.writeRows(seedRows)
    const identicalVersion = await identical.commit()

    expect(identicalVersion.outcome).toBe("unchanged")
    expect(identicalVersion.versionId).toBe(seedVersion.versionId)
    expect(await duckLakeSnapshotCount(storage, rootDir)).toBe(snapshotCountAfterSeed)

    const reordered = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "snapshot",
    })
    await reordered.writeRows([...seedRows].reverse())
    const reorderedVersion = await reordered.commit()

    expect(reorderedVersion.outcome).toBe("unchanged")
    expect(reorderedVersion.versionId).toBe(seedVersion.versionId)
    expect(await duckLakeSnapshotCount(storage, rootDir)).toBe(snapshotCountAfterSeed)

    const changed = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "snapshot",
    })
    await changed.writeRows([
      { orderId: "ord_1", customerName: "Ada", orderCount: 1 },
      {
        orderId: "ord_2",
        customerName: "Hedy",
        orderCount: 2,
        metadata: { source: "erp" },
      },
    ])
    const changedVersion = await changed.commit()

    expect(changedVersion.outcome).toBe("created")
    expect(changedVersion.versionId).not.toBe(seedVersion.versionId)
    expect(await duckLakeSnapshotCount(storage, rootDir)).toBe(snapshotCountAfterSeed + 1)
    await expect(collectRows(storage.readRows({ datasetId: ordersDataset.id }))).resolves.toEqual([
      { orderId: "ord_1", customerName: "Ada", orderCount: "1", metadata: null },
      { orderId: "ord_2", customerName: "Hedy", orderCount: "2", metadata: { source: "erp" } },
    ])
  })

  test("append mode still commits duplicate source rows", async () => {
    const seed = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "snapshot",
    })
    await seed.writeRows([{ orderId: "ord_1", customerName: "Ada", orderCount: 1 }])
    const seedVersion = await seed.commit()

    const append = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "append",
    })
    await append.writeRows([{ orderId: "ord_1", customerName: "Ada", orderCount: 1 }])
    const appendVersion = await append.commit()

    expect(appendVersion.versionId).not.toBe(seedVersion.versionId)
    expect(appendVersion.mode).toBe("append")
    // Unguarded appends omit row counts from commit metadata (DuckLake may retry
    // and underreport previousRowCount + sourceRowCount), and version reads are a
    // metadata-only path that never counts historical table contents. The
    // committed duplicate rows below are the real proof that append does not dedupe.
    expect(appendVersion.rowCount).toBeUndefined()
    await expect(collectRows(storage.readRows({ datasetId: ordersDataset.id }))).resolves.toEqual([
      { orderId: "ord_1", customerName: "Ada", orderCount: "1", metadata: null },
      { orderId: "ord_1", customerName: "Ada", orderCount: "1", metadata: null },
    ])
  })

  test("commits a snapshot replacement to empty rows", async () => {
    const seed = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "snapshot",
    })
    await seed.writeRows([{ orderId: "ord_1", customerName: "Ada", orderCount: 1 }])
    const previous = await seed.commit()

    const replacement = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "snapshot",
    })
    const version = await replacement.commit()

    expect(version.versionId).not.toBe(previous.versionId)
    expect(version.mode).toBe("snapshot")
    expect(version.rowCount).toBe(0)
    expect(await storage.getLatestVersion(ordersDataset.id)).toMatchObject({
      versionId: version.versionId,
      mode: "snapshot",
      rowCount: 0,
    })
    await expect(collectRows(storage.readRows({ datasetId: ordersDataset.id }))).resolves.toEqual(
      []
    )
  })
})

describe("DuckLakeStorage keyed snapshot writes", () => {
  let rootDir: string
  let storage: DuckLakeStorage

  const accounts = defineDataset("crm.accounts", {
    schema: [col("id", "string"), col("name", "string"), col("score", "int64")],
    primaryKey: "id",
  })

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-keyed-snapshots-"))
    storage = createLocalDuckLakeStorage(rootDir)
  })

  afterEach(async () => {
    await storage.close()
    await rm(rootDir, { recursive: true, force: true })
  })

  // Regression proof: in applyKeyedSnapshot, return replaceRows(...) for every changed write. The
  // version then deletes and inserts all 2,000 rows.
  test("writes only the rows that changed, and reads exactly the rows written", async () => {
    await storage.createDataset(accounts)
    const seedRows = accountRows(2_000)
    const seed = await snapshot(accounts, seedRows)

    // The same rows in another order are the same content.
    const reordered = await snapshot(accounts, [...seedRows].reverse())
    expect(reordered).toMatchObject({ outcome: "unchanged", versionId: seed.versionId })

    // Three rows change, two go, two arrive.
    const nextRows = [
      ...seedRows
        .filter((row) => row.id !== "a5" && row.id !== "a6")
        .map((row) =>
          row.id === "a1" || row.id === "a2" || row.id === "a3" ? { ...row, name: "renamed" } : row
        ),
      { id: "new1", name: "new", score: 1 },
      { id: "new2", name: "new", score: 2 },
    ]
    const next = await snapshot(accounts, nextRows)

    expect(next).toMatchObject({ outcome: "created", mode: "snapshot", rowCount: 2_000 })
    expect(await feedOf(accounts, next.versionId)).toEqual({ delete: 5, insert: 5 })
    expect(await commitMetadataForVersion(storage, rootDir, next.versionId)).toMatchObject({
      rowChanges: 10,
    })

    expect(await sortedRows(accounts, next.versionId)).toEqual(readRows(nextRows))
    expect(await sortedRows(accounts, seed.versionId)).toEqual(readRows(seedRows))
  }, 30_000)

  // Regression proof: in applyKeyedSnapshot, drop the return for a write that changes no key. The
  // version of identical rows then rewrites one, and records that it changed rows.
  test("records a version of identical keyed rows from new inputs as changing none", async () => {
    await storage.createDataset(accounts)
    const seedRows = accountRows(100)
    await snapshot(accounts, seedRows)

    const write = await storage.beginWrite({
      dataset: accounts,
      mode: "snapshot",
      inputs: [{ datasetId: "crm.sources", versionId: "ducklake:1" }],
    })
    await write.writeRows([...seedRows].reverse())
    const provenanceOnly = await write.commit()

    expect(provenanceOnly).toMatchObject({ outcome: "created", rowsChanged: false })
    expect(await feedOf(accounts, provenanceOnly.versionId)).toEqual({})
    expect(
      await commitMetadataForVersion(storage, rootDir, provenanceOnly.versionId)
    ).toMatchObject({ rowChanges: 0, rowsChanged: false })

    const growth = await snapshot(accounts, [...seedRows, { id: "new1", name: "new", score: 1 }])
    expect(growth).toMatchObject({ outcome: "created", rowsChanged: true })
  }, 30_000)

  // Regression proof: in replacesEveryRow, drop either rule. The write changing 800 of 1,000 rows,
  // or the one changing 5,000 of 10,000, then deletes and inserts only those.
  test("replaces every row once 80% of them change, or 5% of a large table", async () => {
    await storage.createDataset(accounts)
    const small = accountRows(1_000)
    await snapshot(accounts, small)

    const below = await snapshot(accounts, rescored(small, 799, 1))
    expect(await feedOf(accounts, below.versionId)).toEqual({ delete: 799, insert: 799 })

    const at = await snapshot(accounts, rescored(small, 800, 2))
    expect(await feedOf(accounts, at.versionId)).toEqual({ delete: 1_000, insert: 1_000 })
    expect(await commitMetadataForVersion(storage, rootDir, at.versionId)).toMatchObject({
      rowChanges: 2_000,
    })
    expect(await sortedRows(accounts, at.versionId)).toEqual(readRows(rescored(small, 800, 2)))

    // 5,000 rows of 10,000 is a large difference: a replacement, where 4,999 is not.
    const large = accountRows(10_000)
    await snapshot(accounts, large)

    const fewer = await snapshot(accounts, rescored(large, 4_999, 3))
    expect(await feedOf(accounts, fewer.versionId)).toEqual({ delete: 4_999, insert: 4_999 })

    const enough = await snapshot(accounts, rescored(large, 5_000, 4))
    expect(await feedOf(accounts, enough.versionId)).toEqual({ delete: 10_000, insert: 10_000 })
    expect(await sortedRows(accounts, enough.versionId)).toEqual(
      readRows(rescored(large, 5_000, 4))
    )
  }, 30_000)

  // Regression proof: make the write coordinator's uncomparedReplacementStreak return undefined.
  // The first write after the replacement then compares its rows and writes only the one that
  // changed. Or ignore the parent's uncomparedReplacements: with a new provider for each write,
  // as a process per run has, no write compares again. Or drop the LARGE_TABLE_ROWS bound: the
  // small table's write then replaces every row.
  test("replaces every row of a large table without comparing them after a replacement, and compares every 8th", async () => {
    await storage.createDataset(accounts)
    let rows = accountRows(100_000)
    let latest = (await guardedSnapshot(accounts, rows, null)).versionId

    // Every row changes: a replacement, compared with the table first.
    rows = rescored(rows, 100_000, 1)
    latest = (await guardedSnapshot(accounts, rows, latest)).versionId
    expect(await feedOf(accounts, latest)).toEqual({ delete: 100_000, insert: 100_000 })

    // Then one row changes per write, each from a new provider: seven replacements without
    // comparing, then a difference.
    const feeds = []
    for (let write = 1; write <= 9; write++) {
      await storage.close()
      storage = createLocalDuckLakeStorage(rootDir)

      rows = rows.map((row) => (row.id === `a${write}` ? { ...row, name: "renamed" } : row))
      latest = (await guardedSnapshot(accounts, rows, latest)).versionId
      feeds.push(await feedOf(accounts, latest))
    }
    expect(await sortedRows(accounts, latest)).toEqual(readRows(rows))

    const replaced = { delete: 100_000, insert: 100_000 }
    const changed = { delete: 1, insert: 1 }
    expect(feeds).toEqual([...Array(7).fill(replaced), changed, changed])

    // In a smaller table, a replacement says nothing: the next write compares.
    const small = defineDataset("crm.small_accounts", {
      schema: accounts.schema.columns,
      primaryKey: "id",
    })
    await storage.createDataset(small)
    let smallRows = accountRows(1_000)
    let smallLatest = (await guardedSnapshot(small, smallRows, null)).versionId
    smallRows = rescored(smallRows, 1_000, 1)
    smallLatest = (await guardedSnapshot(small, smallRows, smallLatest)).versionId
    smallRows = smallRows.map((row) => (row.id === "a1" ? { ...row, name: "renamed" } : row))
    smallLatest = (await guardedSnapshot(small, smallRows, smallLatest)).versionId
    expect(await feedOf(small, smallLatest)).toEqual(changed)
  }, 60_000)

  // Regression proof: in applyKeyedSnapshot, report mostRowsChanged for any replacement of a
  // non-empty table. The write after the catch-up then replaces all 100,000 rows for one change.
  // Or report it for an empty table too: the write after the first one does the same.
  test("compares the rows after a replacement that a large difference caused", async () => {
    await storage.createDataset(accounts)
    let rows = accountRows(100_000)
    let latest = (await guardedSnapshot(accounts, rows, null)).versionId

    // Nothing to compare with: the first write says nothing of the next one either.
    rows = rows.map((row) => (row.id === "a1" ? { ...row, name: "renamed" } : row))
    latest = (await guardedSnapshot(accounts, rows, latest)).versionId
    expect(await feedOf(accounts, latest)).toEqual({ delete: 1, insert: 1 })

    // A catch-up: 5% of the rows change, a replacement at this size.
    rows = rescored(rows, 5_000, 1)
    latest = (await guardedSnapshot(accounts, rows, latest)).versionId
    expect(await feedOf(accounts, latest)).toEqual({ delete: 100_000, insert: 100_000 })

    rows = rows.map((row) => (row.id === "a2" ? { ...row, name: "renamed" } : row))
    latest = (await guardedSnapshot(accounts, rows, latest)).versionId
    expect(await feedOf(accounts, latest)).toEqual({ delete: 1, insert: 1 })
  }, 60_000)

  // Regression proof: in applyKeyedSnapshot, drop the check of the table's row count. The
  // snapshots then keep the second a1 another client inserted: 101 rows for a recorded 100.
  test("replaces a table holding a key twice, which another client inserted", async () => {
    await storage.createDataset(accounts)
    const rows = accountRows(100)
    let latest = (await guardedSnapshot(accounts, rows, null)).versionId

    const insertDuplicate = async () => {
      await (storage as unknown as DuckLakeStorageInternals).connections.withExclusiveAttached(
        async (runtime) => {
          await runtime.run(
            `INSERT INTO sixb_lake.main.${quoteIdentifier(encodeDatasetTableName(accounts.id))}
             VALUES ('a1', 'account 1', 1)`
          )
        }
      )
      return (await storage.getLatestVersion(accounts.id))!.versionId
    }

    // The same rows again, then one row changed: each replaces the table, without the duplicate.
    for (const next of [
      rows,
      rows.map((row) => (row.id === "a5" ? { ...row, name: "renamed" } : row)),
    ]) {
      latest = await insertDuplicate()
      const version = await guardedSnapshot(accounts, next, latest)
      expect(version).toMatchObject({ outcome: "created", rowCount: 100 })
      expect(await feedOf(accounts, version.versionId)).toEqual({ delete: 101, insert: 100 })
      expect(await sortedRows(accounts, version.versionId)).toEqual(readRows(next))
      latest = version.versionId
    }
  }, 30_000)

  // Regression proof: in applyKeyedSnapshot, drop the delete or the insert statement. The
  // shrinking or the growing write then keeps rows it removed, or loses rows it added.
  test("writes a snapshot that only adds or only removes rows", async () => {
    await storage.createDataset(accounts)
    const seedRows = accountRows(100)
    await snapshot(accounts, seedRows)

    const grown = [...seedRows, { id: "new1", name: "new", score: 1 }]
    const growth = await snapshot(accounts, grown)
    // A difference that only adds or only removes rows also rewrites an unchanged one.
    expect(await feedOf(accounts, growth.versionId)).toEqual({ delete: 1, insert: 2 })
    expect(await sortedRows(accounts, growth.versionId)).toEqual(readRows(grown))

    const shrunk = grown.filter((row) => row.id !== "a7")
    const shrink = await snapshot(accounts, shrunk)
    expect(await feedOf(accounts, shrink.versionId)).toEqual({ delete: 2, insert: 1 })
    expect(await sortedRows(accounts, shrink.versionId)).toEqual(readRows(shrunk))

    const emptied = await snapshot(accounts, [])
    expect(emptied).toMatchObject({ outcome: "created", rowCount: 0 })
    expect(await sortedRows(accounts, emptied.versionId)).toEqual([])
  }, 30_000)

  // Regression proof: in applyKeyedSnapshot, return replaceRows(...) for every changed write. The
  // partitioned write then deletes and inserts all 40 rows.
  test("keeps rewriting an unkeyed snapshot, and diffs a partitioned keyed one", async () => {
    const events = defineDataset("raw.events", {
      schema: [col("id", "string"), col("name", "string"), col("score", "int64")],
    })
    const partitioned = defineDataset("crm.accounts_by_score", {
      schema: accounts.schema.columns,
      primaryKey: "id",
      partitionBy: ["score"],
    })
    await storage.createDataset(events)
    await storage.createDataset(partitioned)

    const seedRows = accountRows(40)
    await snapshot(events, seedRows)
    await snapshot(partitioned, seedRows)

    const nextRows = rescored(seedRows, 1, 3)
    const unkeyed = await snapshot(events, nextRows)
    expect(await feedOf(events, unkeyed.versionId)).toEqual({ delete: 40, insert: 40 })

    // Partitioned by score: the changed row moves to another partition.
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const keyed = await snapshot(partitioned, nextRows)
      expect(await feedOf(partitioned, keyed.versionId)).toEqual({ delete: 1, insert: 1 })
      expect(await sortedRows(partitioned, keyed.versionId)).toEqual(readRows(nextRows))
    } finally {
      warn.mockRestore()
    }
  }, 30_000)

  // Regression proof: as above, the write then deletes and inserts all 50 rows.
  test("writes only the rows that fill a column added later", async () => {
    await storage.createDataset(accounts)
    const seedRows = accountRows(50)
    await snapshot(accounts, seedRows)

    const evolved = defineDataset(accounts.id, {
      schema: [...accounts.schema.columns, col("region", "string", { nullable: true })],
      primaryKey: "id",
    })
    await storage.createDataset(evolved)

    const nextRows = seedRows.map((row) =>
      row.id === "a1" || row.id === "a2" ? { ...row, region: "eu" } : row
    )
    const next = await snapshot(evolved, nextRows)

    expect(await feedOf(evolved, next.versionId)).toEqual({ delete: 2, insert: 2 })
    expect(await sortedRows(evolved, next.versionId)).toEqual(
      readRows(nextRows).map((row) => ({ region: null, ...row }))
    )
  }, 30_000)

  async function snapshot(dataset: DatasetDefinition, rows: readonly DatasetRow[]) {
    const write = await storage.beginWrite({ dataset, mode: "snapshot" })
    await write.writeRows(rows)
    return write.commit()
  }

  /** A snapshot guarded on the version it builds on, as pipeline steps write. */
  async function guardedSnapshot(
    dataset: DatasetDefinition,
    rows: readonly DatasetRow[],
    expectedLatestVersionId: string | null
  ) {
    const write = await storage.beginWrite({ dataset, mode: "snapshot" })
    await write.writeRows(rows)
    return write.commit({ expectedLatestVersionId })
  }

  async function sortedRows(dataset: DatasetDefinition, versionId: string) {
    const rows = await collectRows(storage.readRows({ datasetId: dataset.id, versionId }))
    return rows.sort((left, right) => String(left.id).localeCompare(String(right.id)))
  }

  /** What DuckLake's change feed holds for one version: rows inserted and deleted, by kind. */
  async function feedOf(dataset: DatasetDefinition, versionId: string) {
    const runtime = await (
      storage as unknown as DuckLakeStorageInternals
    ).connections.attachedRuntime()
    const snapshotId = parseVersionId(versionId)
    const rows = await runtime.query(`
      SELECT change_type, count(*) AS row_count
      FROM ducklake_table_changes(
        'sixb_lake', 'main', ${quoteSqlString(encodeDatasetTableName(dataset.id))},
        ${snapshotId}, ${snapshotId}
      )
      GROUP BY change_type
    `)

    return Object.fromEntries(rows.map((row) => [row.change_type, Number(row.row_count)]))
  }
})

function accountRows(count: number): DatasetRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `a${index}`,
    name: `account ${index}`,
    score: index % 4,
  }))
}

/** The first `count` rows with a new score. */
function rescored(rows: readonly DatasetRow[], count: number, score: number): DatasetRow[] {
  return rows.map((row, index) => (index < count ? { ...row, score: 10 + score } : row))
}

function readRow(row: DatasetRow): DatasetRow {
  return { ...row, score: String(row.score) }
}

function readRows(rows: readonly DatasetRow[]): DatasetRow[] {
  return rows.map(readRow).sort((left, right) => String(left.id).localeCompare(String(right.id)))
}

async function commitMetadataForVersion(
  storage: DuckLakeStorage,
  rootDir: string,
  versionId: string
) {
  return parseCommitMetadata(await commitExtraInfoForVersion(storage, rootDir, versionId))
}

async function commitExtraInfoForVersion(
  storage: DuckLakeStorage,
  rootDir: string,
  versionId: string
) {
  const runtime = await (
    storage as unknown as DuckLakeStorageInternals
  ).connections.attachedRuntime()
  const snapshotId = parseVersionId(versionId)
  const [row] = await runtime.query(`
    SELECT commit_extra_info
    FROM ${duckLakeMetadataTableName(localDuckLakeOptions(rootDir), "ducklake_snapshot_changes")}
    WHERE snapshot_id = ${snapshotId}
  `)

  return row?.commit_extra_info
}

async function duckLakeSnapshotCount(storage: DuckLakeStorage, rootDir: string): Promise<number> {
  const runtime = await (
    storage as unknown as DuckLakeStorageInternals
  ).connections.attachedRuntime()
  const [row] = await runtime.query(`
    SELECT count(*) AS row_count
    FROM ${duckLakeMetadataTableName(localDuckLakeOptions(rootDir), "ducklake_snapshot")}
  `)

  return Number(row?.row_count ?? 0)
}
