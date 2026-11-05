import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { change, col, type DatasetDefinition, type DatasetRow, defineDataset } from "@sixb/core"
import type { DatasetStorageHealth, DatasetVersion } from "@sixb/core/lake-storage"
import type { DuckLakeStorage } from "../src"
import type { DuckDbExclusiveRuntime } from "../src/internal/duckdb-runtime"
import { encodeDatasetSequenceTableName, encodeDatasetTableName } from "../src/internal/names"
import { quoteSqlString } from "../src/internal/sql"
import { collectRows, createLocalDuckLakeStorage } from "./test-utils"

interface DuckLakeStorageInternals {
  readonly connections: {
    withExclusiveAttached<T>(run: (runtime: DuckDbExclusiveRuntime) => Promise<T>): Promise<T>
  }
  readonly compaction: {
    plan(dataset: DatasetDefinition): Promise<unknown>
  }
}

const items = defineDataset("raw.webhook.items", {
  schema: [col("id", "string"), col("revision", "int64"), col("name", "string")],
  primaryKey: "id",
  sequenceBy: "revision",
})

const accounts = defineDataset("crm.accounts", {
  schema: [col("id", "string"), col("score", "int64")],
  primaryKey: "id",
})

const events = defineDataset("raw.events", {
  schema: [col("id", "string"), col("batch", "int64")],
})

describe("DuckLakeStorage compaction", () => {
  let rootDir: string
  let catalog: "duckdb" | "sqlite"
  let storage: DuckLakeStorage

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-compaction-"))
    catalog = "duckdb"
    storage = createLocalDuckLakeStorage(rootDir, catalog)
  })

  afterEach(async () => {
    await storage.close()
    await rm(rootDir, { recursive: true, force: true })
  })

  for (const catalogType of ["duckdb", "sqlite"] as const) {
    // Regression proof: drop MAINTENANCE_CHANGE_KINDS from parseTableDataChange. The flush, which
    // records `deleted_from_table`, and the rewrite then each read as a new snapshot version.
    test(`${catalogType}: DuckLake's own maintenance commits are never versions`, async () => {
      await useCatalog(catalogType)
      await storage.createDataset(items)
      await storage.createDataset(accounts)

      // Single-row webhook merges stay inlined in the catalog; 20-row merges write small files
      // and mark the rows they replace deleted in the seed file.
      await merge(
        items,
        rows(200, (i) => ({ id: `i${i}`, revision: 0, name: "seed" }))
      )
      for (let w = 1; w <= 6; w++) {
        await merge(items, [{ id: `i${w * 7}`, revision: w, name: `rev ${w}` }])
      }

      await merge(
        accounts,
        rows(1000, (i) => ({ id: `a${i}`, score: 0 }))
      )
      for (let b = 1; b <= 6; b++) {
        await merge(
          accounts,
          rows(20, (i) => ({ id: `a${(b * 37 + i * 11) % 1000}`, score: b }))
        )
      }

      const before = await history([items, accounts])
      const cursor = await storage.listLatestVersionsSince({ cursor: null })

      await maintain([
        `CALL ducklake_flush_inlined_data('sixb_lake', table_name => ${table(items)})`,
        `CALL ducklake_flush_inlined_data('sixb_lake', table_name => ${sequenceTable(items)})`,
      ])
      await maintain([
        `CALL ducklake_rewrite_data_files('sixb_lake', ${table(accounts)}, delete_threshold => 0)`,
        `CALL ducklake_merge_adjacent_files('sixb_lake', ${table(accounts)})`,
        `CALL ducklake_rewrite_data_files('sixb_lake', ${table(items)}, delete_threshold => 0)`,
      ])

      expect(await history([items, accounts])).toEqual(before)
      expect(
        await storage.listLatestVersionsSince({ cursor: cursor?.cursor ?? null })
      ).toMatchObject({ versions: [] })
    }, 30_000)

    // Regression proof: make the write coordinator's versionCreated a no-op in DuckLakeStorage.
    // The 17 small files then stay.
    test(`${catalogType}: merges small files after the write that makes too many`, async () => {
      await useCatalog(catalogType)
      await storage.createDataset(events)

      // Over DuckLake's inlining limit, each append writes a file. A new provider checks its
      // first commit, the 17th file.
      const versions: DatasetVersion[] = []
      for (let batch = 1; batch <= 16; batch++) {
        versions.push(await append(events, batchRows(batch)))
      }
      await reopen()
      versions.push(await append(events, batchRows(17)))

      const health = await settled(events)
      expect(health).toMatchObject({ dataFiles: 1, smallDataFiles: 1, rowCount: 17 * 20 })

      // Every version still reads the rows it held, through the merged file.
      expect((await storage.listVersions(events.id)).map((version) => version.versionId)).toEqual(
        versions.map((version) => version.versionId).reverse()
      )
      for (const [index, version] of versions.entries()) {
        const read = await collectRows(
          storage.readRows({ datasetId: events.id, versionId: version.versionId })
        )
        expect(read).toEqual(rows(index + 1, (batch) => readBatch(batch + 1)).flat())
      }
    }, 30_000)
  }

  // Regression proof: in DuckLakeCompaction.compactOnce, skip the flush. The inlined rows of both
  // tables then stay in the catalog.
  test("flushes a dataset's inlined rows to files once they cross the threshold", async () => {
    await storage.createDataset(items)
    await setInliningLimit(1_000)

    // 600 rows inlined in the dataset's table and in its source-ordering table: 1,200 in all.
    const version = await merge(
      items,
      rows(600, (i) => ({ id: `i${i}`, revision: 1, name: "seed" }))
    )
    const before = await history([items])

    const health = await settled(items)
    expect(health).toMatchObject({ inlinedRows: 0, rowCount: 600 })
    expect(health.dataFiles).toBeGreaterThanOrEqual(1)
    expect(await history([items])).toEqual(before)
    expect((await storage.getLatestVersion(items.id))?.versionId).toBe(version.versionId)
  })

  // Regression proof: in DuckLakeCompaction.compactCalls, drop the rewrite. The seed file then
  // keeps its delete file.
  test("rewrites a file once a tenth of its rows are deleted", async () => {
    await storage.createDataset(accounts)
    await merge(
      accounts,
      rows(100, (i) => ({ id: `a${i}`, score: 0 }))
    )

    // A new provider checks its first commit: replacing 11 of the 100 seed rows.
    await reopen()
    await merge(
      accounts,
      rows(11, (i) => ({ id: `a${i}`, score: 1 }))
    )
    const before = await history([accounts])

    expect(await settled(accounts)).toMatchObject({ deleteFiles: 0, rowCount: 100 })
    expect(await history([accounts])).toEqual(before)
  })

  // Regression proof: in the write coordinator, await the compaction a commit schedules. The
  // commit then waits for the blocked check, and the test times out.
  test("returns the version before compaction looks at the dataset", async () => {
    await storage.createDataset(events)
    const check = blockChecks()

    try {
      const version = await append(events, batchRows(1))

      expect(check.calls()).toBe(1)
      expect(check.settled()).toEqual([])
      expect((await storage.getLatestVersion(events.id))?.versionId).toBe(version.versionId)
    } finally {
      check.release()
    }
  })

  // Regression proof: remove the try/catch in DuckLakeCompaction.run. The failure then escapes
  // as an unhandled rejection.
  test("reports a failed compaction without failing the write", async () => {
    await storage.createDataset(events)
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    const plan = spyOn(internals(storage).compaction, "plan").mockImplementation(async () => {
      throw new Error("catalog unreachable")
    })

    try {
      const version = await append(events, batchRows(1))
      await storage.close()

      expect(version.outcome).toBe("created")
      expect(plan).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toStartWith(
        "[SixbDuckLake] Automatic compaction of dataset 'raw.events' failed."
      )
    } finally {
      warn.mockRestore()
      plan.mockRestore()
    }
  })

  // Regression proof: in DuckLakeCompaction.afterCommit, start a check whatever is in flight. The
  // ninth commit then starts a second check of the dataset beside the blocked one.
  test("runs one compaction per dataset at a time, and one more pass for commits meanwhile", async () => {
    await storage.createDataset(events)
    const check = blockChecks()

    try {
      await append(events, batchRows(1))
      for (let batch = 2; batch <= 10; batch++) {
        await append(events, batchRows(batch))
      }
      expect(check.calls()).toBe(1)
    } finally {
      check.release()
    }

    await check.called(2)
    await storage.close()
    expect(check.calls()).toBe(2)
  })

  // Regression proof: in DuckLakeStorage.close, close the connections without waiting for the
  // compaction. The released check then runs on a closed lake, and fails.
  test("close waits for the compaction in flight and starts no other", async () => {
    await storage.createDataset(events)
    const check = blockChecks()
    await append(events, batchRows(1))

    const close = storage.close()
    check.release()
    await close

    expect(check.settled()).toEqual(["fulfilled"])
    expect(check.calls()).toBe(1)
  })

  // Regression proof: drop warnedPartitionedDatasets from DuckLakeCompaction. The second provider
  // then warns again.
  test("warns once per process about a partitioned dataset too small for it", async () => {
    const partitioned = defineDataset("raw.partitioned.readings", {
      schema: [col("id", "string"), col("day", "string")],
      partitionBy: ["day"],
    })
    await storage.createDataset(partitioned)
    const warn = spyOn(console, "warn").mockImplementation(() => {})

    try {
      await append(partitioned, [{ id: "r1", day: "2026-11-01" }])
      await reopen()
      await append(partitioned, [{ id: "r2", day: "2026-11-02" }])
      await storage.close()

      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain(
        "[SixbDuckLake] Dataset 'raw.partitioned.readings' is partitioned by day but holds 1 row."
      )
    } finally {
      warn.mockRestore()
    }
  })

  async function useCatalog(type: "duckdb" | "sqlite"): Promise<void> {
    await storage.close()
    catalog = type
    rootDir = await mkdtemp(join(rootDir, `${type}-`))
    storage = createLocalDuckLakeStorage(rootDir, catalog)
  }

  async function reopen(): Promise<void> {
    await storage.close()
    storage = createLocalDuckLakeStorage(rootDir, catalog)
  }

  /** Closing waits for the compaction in flight; a new provider then describes the dataset. */
  async function settled(dataset: DatasetDefinition): Promise<DatasetStorageHealth> {
    await reopen()
    const [health] = await storage.maintenance.describeStorage([dataset.id])
    return health as DatasetStorageHealth
  }

  /** Holds every compaction check until released, and records how each one settled. */
  function blockChecks() {
    const compaction = internals(storage).compaction
    const plan = compaction.plan.bind(compaction)
    const settled: ("fulfilled" | "rejected")[] = []
    const waiters: { readonly calls: number; readonly resolve: () => void }[] = []

    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })

    const spy = spyOn(compaction, "plan").mockImplementation(async (dataset) => {
      for (const waiter of waiters) {
        if (spy.mock.calls.length >= waiter.calls) waiter.resolve()
      }

      await released
      try {
        const result = await plan(dataset)
        settled.push("fulfilled")
        return result
      } catch (error) {
        settled.push("rejected")
        throw error
      }
    })

    return {
      release,
      calls: () => spy.mock.calls.length,
      settled: () => [...settled],
      called: (calls: number) =>
        new Promise<void>((resolve) => {
          if (spy.mock.calls.length >= calls) resolve()
          else waiters.push({ calls, resolve })
        }),
    }
  }

  /** Every version of the datasets, with the rows each one reads. */
  async function history(datasets: readonly DatasetDefinition[]): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {}

    for (const dataset of datasets) {
      const latest = await storage.getLatestVersion(dataset.id)
      result[`${dataset.id} latest`] = latest?.versionId

      for (const version of await storage.listVersions(dataset.id)) {
        result[version.versionId] = {
          mode: version.mode,
          rows: await collectRows(
            storage.readRows({ datasetId: dataset.id, versionId: version.versionId })
          ),
        }
      }
    }

    return result
  }

  async function merge(dataset: DatasetDefinition, upserts: readonly Record<string, unknown>[]) {
    const session = await storage.beginMerge({ dataset })
    await session.writeChanges(upserts.map((row) => change.upsert(row)))
    return (await session.commit({ createInitialVersion: true })).version as DatasetVersion
  }

  async function append(dataset: DatasetDefinition, appended: readonly DatasetRow[]) {
    const write = await storage.beginWrite({ dataset, mode: "append" })
    await write.writeRows(appended)
    return write.commit()
  }

  async function setInliningLimit(rowLimit: number): Promise<void> {
    await maintain([`CALL sixb_lake.set_option('data_inlining_row_limit', ${rowLimit})`])
  }

  /** Runs DuckLake's maintenance calls in one transaction, as any DuckLake client could. */
  async function maintain(calls: readonly string[]): Promise<void> {
    await internals(storage).connections.withExclusiveAttached(async (runtime) => {
      await runtime.run("BEGIN TRANSACTION")
      for (const call of calls) {
        await runtime.run(call)
      }
      await runtime.run("COMMIT")
    })
  }
})

function batchRows(batch: number): DatasetRow[] {
  return rows(20, (i) => ({ id: `b${batch}_${i}`, batch }))
}

/** A batch as reads return it: DuckLake reads int64 values as strings. */
function readBatch(batch: number): DatasetRow[] {
  return batchRows(batch).map((row) => ({ ...row, batch: String(batch) }))
}

function rows<T>(count: number, row: (index: number) => T): T[] {
  return Array.from({ length: count }, (_, index) => row(index))
}

function table(dataset: DatasetDefinition): string {
  return quoteSqlString(encodeDatasetTableName(dataset.id))
}

function sequenceTable(dataset: DatasetDefinition): string {
  return quoteSqlString(encodeDatasetSequenceTableName(dataset.id))
}

function internals(storage: DuckLakeStorage): DuckLakeStorageInternals {
  return storage as unknown as DuckLakeStorageInternals
}
