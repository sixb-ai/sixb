import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  change,
  col,
  type DatasetDefinition,
  type DatasetRow,
  defineDataset,
  defineMarking,
} from "@sixb/core"
import type { BeginDatasetWriteInput, DatasetVersion } from "@sixb/core/lake-storage"
import { createDatasetVersionMarkings } from "../../../packages/core/src/security/dataset-version-markings"
import { DuckLakeStorage, type DuckLakeStorageOptions } from "../src"
import { encodeDatasetSequenceTableName, encodeDatasetTableName } from "../src/internal/names"
import { duckLakeMetadataTableName, quoteSqlString } from "../src/internal/sql"
import { parseVersionId } from "../src/internal/versions"
import { collectRows, createLocalDuckLakeStorage, localDuckLakeOptions } from "./test-utils"

interface DuckLakeStorageInternals {
  readonly connections: {
    attachedRuntime(): Promise<{
      query(sql: string): Promise<readonly Record<string, unknown>[]>
      run(sql: string): Promise<void>
    }>
  }
}

const HOUR_MS = 60 * 60 * 1000

/** The shortest retention: versions replaced more than an hour ago expire. */
const ONE_HOUR = { keepVersionsForMs: HOUR_MS, deleteFilesAfterMs: HOUR_MS }

const ordersDataset = defineDataset("raw.maintenance.orders", {
  schema: [col("orderId", "string"), col("total", "int64")],
})

describe("DuckLakeStorage retention", () => {
  let rootDir: string
  let options: DuckLakeStorageOptions
  let storage: DuckLakeStorage

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-maintenance-"))
    options = localDuckLakeOptions(rootDir)
    storage = new DuckLakeStorage(options)
    await storage.createDataset(ordersDataset)
  })

  afterEach(async () => {
    await storage.close()
    await rm(rootDir, { recursive: true, force: true })
  })

  test("retains deletion ordering after snapshot expiration and reopen", async () => {
    // Tombstones live in current transactional state. They must not depend on expired versions.
    const dataset = defineDataset("source.maintenance", {
      schema: [col("id", "string"), col("revision", "int64")],
      primaryKey: "id",
      sequenceBy: "revision",
    })
    await storage.createDataset(dataset)
    const deleted = await storage.beginMerge({ dataset })
    await deleted.writeChanges([change.delete({ id: "42" }, { sequence: 9 })])
    await deleted.commit()

    // Advance another dataset, making the deletion snapshot eligible for expiration.
    await writeSnapshot([{ orderId: "other", total: 1 }])
    await writeSnapshot([{ orderId: "other", total: 2 }])
    await backdateHistory("2 hours")
    await storage.maintenance.applyRetention(ONE_HOUR)

    await storage.close()
    storage = createLocalDuckLakeStorage(rootDir)

    const stale = await storage.beginMerge({ dataset })
    await stale.writeChanges([change.upsert({ id: "42", revision: 8 })])
    expect((await stale.commit()).outcome).toBe("unchanged")

    const restore = await storage.beginMerge({ dataset })
    await restore.writeChanges([change.upsert({ id: "42", revision: 10 })])
    expect((await restore.commit()).outcome).toBe("created")
    expect(await collectRows(storage.readRows({ datasetId: dataset.id }))).toEqual([
      { id: "42", revision: "10" },
    ])
  })

  for (const catalog of ["duckdb", "sqlite"] as const) {
    // Regression proof: in DuckLakeMaintenance.planExpiry, expire every version past the cutoff,
    // the last of its dataset included. The idle dataset then has no version left, and its rows
    // no version to read them through.
    test(`${catalog}: keeps the latest version of an idle dataset and expires the rest`, async () => {
      const idle = defineDataset("idle.rooms", { schema: [col("id", "string")] })
      const busy = defineDataset("busy.readings", { schema: [col("id", "string")] })

      await useCatalog(catalog)
      await storage.createDataset(idle)
      await storage.createDataset(busy)
      const idleVersion = await write(idle, "snapshot", [{ id: "room_1" }])
      const replaced = await write(busy, "snapshot", [{ id: "reading_1" }])
      await write(busy, "snapshot", [{ id: "reading_2" }])
      await backdateHistory("2 hours")

      const report = await storage.maintenance.applyRetention(ONE_HOUR)

      expect(report).toMatchObject({ keptVersions: 0, hasMore: false })
      expect(report.expiredVersions).toBeGreaterThan(0)
      expect((await storage.getLatestVersion(idle.id))?.versionId).toBe(idleVersion.versionId)
      expect(await collectRows(storage.readRows({ datasetId: idle.id }))).toEqual([
        { id: "room_1" },
      ])
      expect(await storage.getVersion(busy.id, replaced.versionId)).toBeNull()
    })

    // Regression proof: in DuckLakeMaintenance.planExpiry, expire a version as soon as its own
    // commit is past the cutoff. The version replaced half an hour ago then expires, though a
    // pipeline step that resolved it as the latest version may still be reading it.
    // On SQLite, also: compare the stored snapshot time without the cast in readHistoryPage, and
    // run with TZ=America/New_York. A version replaced a moment ago then expires.
    test(`${catalog}: ages a version from the commit that replaced it`, async () => {
      await useCatalog(catalog)
      const rooms = defineDataset("rooms", { schema: [col("id", "string")] })
      await storage.createDataset(rooms)

      const first = await write(rooms, "snapshot", [{ id: "a" }])
      await backdateHistory("3 days")
      const second = await write(rooms, "snapshot", [{ id: "b" }])
      await backdateHistory("30 minutes", second.versionId)

      await storage.maintenance.applyRetention(ONE_HOUR)
      expect(await storage.getVersion(rooms.id, first.versionId)).not.toBeNull()

      await backdateHistory("2 hours", second.versionId)
      const third = await write(rooms, "snapshot", [{ id: "c" }])

      await storage.maintenance.applyRetention(ONE_HOUR)
      expect(await storage.getVersion(rooms.id, first.versionId)).toBeNull()
      expect(await storage.getVersion(rooms.id, second.versionId)).not.toBeNull()
      expect((await storage.getLatestVersion(rooms.id))?.versionId).toBe(third.versionId)
    })

    // Old versions of an append-only dataset expire like any other: the latest version records
    // the lineage of every row it holds, so its classification reads no expired version.
    test(`${catalog}: expires old appends without changing the latest append's markings`, async () => {
      const pii = defineMarking("pii")
      const raw = defineDataset("raw_people", {
        schema: [col("id", "string"), col("taxId", "string", { markings: [pii] })],
      })
      const people = defineDataset("people", {
        schema: [col("id", "string"), col("label", "string")],
      })

      const markings = createDatasetVersionMarkings({
        datasets: { list: () => [raw, people] },
        lakeStorage: { recordsLineage: true },
      })
      const fromRaw = (label: string) => ({
        producer: { kind: "pipeline", id: "people", stepId: "normalize-people" } as const,
        lineage: {
          rows: [],
          columns: {
            id: [{ datasetId: raw.id, column: "id" }],
            label: [{ datasetId: raw.id, column: label }],
          },
        },
      })

      await useCatalog(catalog)
      await storage.createDataset(withoutMarkings(raw))
      await storage.createDataset(people)
      await write(raw, "snapshot", [{ id: "p1", taxId: "TAX-1" }])

      // An earlier revision of the step copied the tax id into the label.
      const leaked = await write(people, "append", [{ id: "p1", label: "TAX-1" }], fromRaw("taxId"))
      const latest = await write(people, "append", [{ id: "p2", label: "p2" }], fromRaw("id"))

      const before = markings.classify(latest)
      expect(before.columns.get("label")).toEqual(new Set(["pii"]))

      await backdateHistory("2 hours")
      await storage.maintenance.applyRetention(ONE_HOUR)

      expect(await storage.getVersion(people.id, leaked.versionId)).toBeNull()
      const kept = await storage.getVersion(people.id, latest.versionId)
      expect(markings.classify(kept as DatasetVersion)).toEqual(before)
    })

    // Regression proof: in DuckLakeMaintenance, ignore `protect`. The version a projection applied
    // then expires.
    test(`${catalog}: keeps protected versions, then deletes the files expiry freed`, async () => {
      await useCatalog(catalog)
      const rooms = defineDataset("rooms", { schema: [col("id", "string")] })
      await storage.createDataset(rooms)

      const rows = (prefix: string) =>
        Array.from({ length: 50 }, (_, index) => ({ id: `${prefix}_${index}` }))
      const replaced = await write(rooms, "snapshot", rows("a"))
      const applied = await write(rooms, "snapshot", rows("b"))
      const appended = await write(rooms, "append", rows("c"))
      await write(rooms, "snapshot", rows("d"))
      await backdateHistory("2 hours")

      const snapshotsBefore = await snapshotCount()
      const retention = {
        ...ONE_HOUR,
        protect: [{ datasetId: rooms.id, versionId: applied.versionId }],
      }

      const preview = await storage.maintenance.applyRetention({ ...retention, dryRun: true })
      expect(await snapshotCount()).toBe(snapshotsBefore)
      const report = await storage.maintenance.applyRetention(retention)

      expect(preview).toMatchObject({ dryRun: true, keptVersions: 1 })
      expect(report).toMatchObject({ dryRun: false, keptVersions: 1, deletedFiles: 0 })
      expect(preview.expiredVersions).toBe(report.expiredVersions)
      expect(snapshotsBefore - (await snapshotCount())).toBe(report.expiredVersions)
      expect(await storage.getVersion(rooms.id, replaced.versionId)).toBeNull()
      expect(await storage.getVersion(rooms.id, appended.versionId)).toBeNull()
      expect(
        await collectRows(storage.readRows({ datasetId: rooms.id, versionId: applied.versionId }))
      ).toEqual(rows("b"))

      // The files only expired versions read go once their deletion is due. Two days cover every
      // zone a SQLite catalog may be compared in (see deleteScheduledFiles).
      expect(await scheduledFileCount()).toBeGreaterThan(0)
      await backdateScheduledFiles(["2 days"])

      const sweep = await storage.maintenance.applyRetention(retention)
      expect(sweep.deletedFiles).toBeGreaterThan(0)
      expect(await scheduledFileCount()).toBe(0)
    })
  }

  // Regression proof: drop MAINTENANCE_CHANGE_KINDS from parseTableDataChange. The flush then is
  // the dataset's latest version, and retention expires the version it really holds.
  test("keeps the latest version, not a later flush of its inlined rows", async () => {
    const items = defineDataset("raw.items", {
      schema: [col("id", "string"), col("revision", "int64"), col("name", "string")],
      primaryKey: "id",
      sequenceBy: "revision",
    })
    await storage.createDataset(items)

    // A seed file, then updates of its rows, inlined: flushing them deletes rows of the file.
    const upsert = async (rows: readonly { id: string; revision: number }[]) => {
      const merge = await storage.beginMerge({ dataset: items })
      await merge.writeChanges(
        rows.map((row) => change.upsert({ ...row, name: `revision ${row.revision}` }))
      )
      return (await merge.commit()).version
    }
    await upsert(Array.from({ length: 20 }, (_, n) => ({ id: `item_${n}`, revision: 0 })))
    let latest: DatasetVersion | null = null
    for (let revision = 1; revision <= 3; revision++) {
      latest = await upsert([{ id: "item_1", revision }])
    }

    const runtime = await internals(storage).connections.attachedRuntime()
    for (const table of [
      encodeDatasetTableName(items.id),
      encodeDatasetSequenceTableName(items.id),
    ]) {
      await runtime.run(
        `CALL ducklake_flush_inlined_data('sixb_lake', table_name => ${quoteSqlString(table)})`
      )
    }
    await backdateHistory("2 hours")

    await storage.maintenance.applyRetention(ONE_HOUR)

    expect((await storage.getLatestVersion(items.id))?.versionId).toBe(latest?.versionId)
    expect(await collectRows(storage.readRows({ datasetId: items.id }))).toContainEqual({
      id: "item_1",
      revision: "3",
      name: "revision 3",
    })
  })

  // Regression proof: in DuckLakeMaintenance.planExpiry, ignore `limit`. The first pass then
  // expires everything and reports nothing left.
  test("expires at most `limit` snapshots per pass and reports what is left", async () => {
    const versions: DatasetVersion[] = []
    for (let total = 1; total <= 8; total++) {
      versions.push(await writeSnapshot([{ orderId: "ord_1", total }]))
    }
    await backdateHistory("2 hours")

    const passes: { readonly expired: number; readonly hasMore: boolean }[] = []
    for (let pass = 0; pass < 10; pass++) {
      const report = await storage.maintenance.applyRetention({ ...ONE_HOUR, limit: 3 })
      passes.push({ expired: report.expiredVersions, hasMore: report.hasMore })
      if (!report.hasMore) break
    }

    expect(passes.slice(0, 2)).toEqual([
      { expired: 3, hasMore: true },
      { expired: 3, hasMore: true },
    ])
    expect(passes.at(-1)?.hasMore).toBe(false)
    for (const version of versions.slice(0, -1)) {
      expect(await storage.getVersion(ordersDataset.id, version.versionId)).toBeNull()
    }
    expect((await storage.getLatestVersion(ordersDataset.id))?.versionId).toBe(
      versions.at(-1)?.versionId
    )
  })

  // Regression proof: in DuckLakeMaintenance.deleteScheduledFiles, always give DuckLake the due
  // time. The first pass then deletes all three files due.
  test("deletes at most `limit` scheduled files per pass, oldest first", async () => {
    await scheduleFiles(["4 days", "3 days", "2 days", "0 seconds"])

    const first = await storage.maintenance.applyRetention({ ...ONE_HOUR, limit: 2 })
    expect(first).toMatchObject({ deletedFiles: 2, hasMore: true })
    expect(await scheduledFileCount()).toBe(2)

    const second = await storage.maintenance.applyRetention({ ...ONE_HOUR, limit: 2 })
    expect(second).toMatchObject({ deletedFiles: 1, hasMore: false })
    expect(await scheduledFileCount()).toBe(1)
  })

  // Regression proof: in deleteScheduledFilesOnSqlite, delete nothing while a file isn't due: this
  // pass then deletes none, as on every pass of a lake that keeps writing. Or skip the method in
  // deleteScheduledFiles: the file scheduled a moment ago then goes with the due ones.
  test("sqlite: deletes the files due, and never a file that isn't", async () => {
    await useCatalog("sqlite")
    await storage.createDataset(ordersDataset)
    await scheduleFiles(["4 days", "3 days", "2 days", "0 seconds"])

    expect((await storage.maintenance.applyRetention(ONE_HOUR)).deletedFiles).toBe(3)
    expect(await scheduledFileCount()).toBe(1)
  })

  // Regression proof: in deleteScheduledFilesOnSqlite, give older_than the first date itself. Text
  // comparison then selects the file not due. Both files are stored under one date, whatever the
  // time of the run: the late one's offset puts it half a day after that date ends.
  test("sqlite: a due file waits for the files stored under its date", async () => {
    await useCatalog("sqlite")
    await storage.createDataset(ordersDataset)
    await scheduleFiles(["2 hours"])

    const twoHoursAgo = new Date(Date.now() - 2 * HOUR_MS).toISOString()
    const date = twoHoursAgo.slice(0, 10)
    const due = `${date} ${twoHoursAgo.slice(11, 19)}+00`

    await storeScheduleTimes(due)
    await storeScheduleTimes(`${date} 23:59:59-12`, { oneFile: true })

    expect((await storage.maintenance.applyRetention(ONE_HOUR)).deletedFiles).toBe(0)
    expect(await scheduledFileCount()).toBe(4)

    await storeScheduleTimes(due)

    expect((await storage.maintenance.applyRetention(ONE_HOUR)).deletedFiles).toBe(4)
    expect(await scheduledFileCount()).toBe(0)
  })

  // DuckLake removes the catalog row of a scheduled file already gone from disk: no pass yields.
  test("deletes the row of a scheduled file someone removed by hand", async () => {
    await scheduleFiles(["2 days"])

    const runtime = await internals(storage).connections.attachedRuntime()
    const [file] = await runtime.query(`
      SELECT path FROM ${duckLakeMetadataTableName(options, "ducklake_files_scheduled_for_deletion")}
      ORDER BY data_file_id LIMIT 1
    `)
    await rm(join(rootDir, "data", String(file?.path)))

    expect(await storage.maintenance.applyRetention(ONE_HOUR)).toMatchObject({
      deletedFiles: 4,
      hasMore: false,
    })
    expect(await scheduledFileCount()).toBe(0)
  })

  // Regression proof: drop countYields from DuckLakeMaintenance.applyRetention. Every pass then
  // yields and reports more to do, and the cleanup that never runs never surfaces.
  test("fails on the third pass in a row that a step yields, naming it", async () => {
    await scheduleFiles(["2 days"])

    // The error a pass that lost a file deletion race got, on every pass: no race explains that.
    const lost = new Error(
      `IO Error: Could not remove file "${join(rootDir, "data", "lost.parquet")}": No such file or directory`
    )
    const maintenance = storage.maintenance as unknown as {
      deleteScheduledFiles(retention: unknown): Promise<unknown>
    }
    const deletion = spyOn(maintenance, "deleteScheduledFiles").mockRejectedValue(lost)

    try {
      for (let pass = 1; pass <= 2; pass++) {
        expect(await storage.maintenance.applyRetention(ONE_HOUR)).toMatchObject({
          deletedFiles: 0,
          hasMore: true,
        })
      }

      const third = await storage.maintenance.applyRetention(ONE_HOUR).catch((error) => error)
      expect(String(third)).toContain(
        "[SixbDuckLake] Lake retention's file deletion failed in 3 passes in a row"
      )
      expect(String(third)).toContain("No such file or directory")
      expect((third as Error).cause).toBe(lost)
    } finally {
      deletion.mockRestore()
    }

    // A pass that yields nothing starts the count again.
    expect(await storage.maintenance.applyRetention(ONE_HOUR)).toMatchObject({ hasMore: false })
  })

  // Regression proof: remove the keepVersionsForMs floor from resolveRetention. Versions replaced
  // a moment ago then expire under readers that resolved them.
  test("refuses to keep replaced versions for less than an hour", async () => {
    const rejected = storage.maintenance.applyRetention({ keepVersionsForMs: HOUR_MS - 1 })

    expect(String(await rejected.catch((error) => error))).toContain(
      "keepVersionsForMs must be at least 3600000 (1 hour)"
    )
  })

  // Regression proof: remove the deleteFilesAfterMs floor from resolveRetention. Orphan deletion
  // then removes the files another process's uncommitted write already put in the data path.
  test("refuses to delete files less than an hour old", async () => {
    const rejected = storage.maintenance.applyRetention({ deleteFilesAfterMs: HOUR_MS - 1 })

    expect(String(await rejected.catch((error) => error))).toContain(
      "deleteFilesAfterMs must be at least 3600000 (1 hour)"
    )
  })

  test("rejects a protected version that is not a DuckLake version", async () => {
    const rejected = storage.maintenance.applyRetention({
      dryRun: true,
      protect: [{ datasetId: ordersDataset.id, versionId: "ver_1" }],
    })

    expect(String(await rejected.catch((error) => error))).toContain(
      "Cannot protect version 'ver_1'"
    )
  })

  test("retention targets the configured DuckLake alias", async () => {
    await storage.close()

    options = { ...localDuckLakeOptions(rootDir), alias: "custom_lake" }
    storage = new DuckLakeStorage(options)
    await storage.createDataset(ordersDataset)
    await writeSnapshot([{ orderId: "ord_1", total: 1 }])
    await writeSnapshot([{ orderId: "ord_2", total: 2 }])
    await backdateHistory("2 hours")
    const snapshotsBefore = await snapshotCount()

    const report = await storage.maintenance.applyRetention(ONE_HOUR)

    expect(report.expiredVersions).toBeGreaterThan(0)
    expect(await snapshotCount()).toBeLessThan(snapshotsBefore)
  })

  test("retention rejects new work after storage closes", async () => {
    await storage.close()

    const rejected = storage.maintenance.applyRetention({ dryRun: true })
    expect(String(await rejected.catch((error) => error))).toContain("closed")
  })

  test("describes each dataset's files, inlined rows and history", async () => {
    const events = defineDataset("raw.events", {
      schema: [col("id", "string"), col("day", "string")],
      partitionBy: ["day"],
    })
    await storage.createDataset(events)

    // Three rows inlined in the catalog, then a file of fifty.
    await write(
      events,
      "append",
      [1, 2, 3].map((n) => ({ id: `e${n}`, day: "d1" }))
    )
    await write(
      events,
      "append",
      Array.from({ length: 50 }, (_, n) => ({ id: `f${n}`, day: "d2" }))
    )
    await writeSnapshot([{ orderId: "ord_1", total: 1 }])

    const [described, orders, missing] = await storage.maintenance.describeStorage([
      events.id,
      ordersDataset.id,
      "never.created",
    ])

    expect(described).toMatchObject({
      datasetId: events.id,
      materialized: true,
      rowCount: 53,
      dataFiles: 1,
      smallDataFiles: 1,
      deleteFiles: 0,
      inlinedRows: 3,
      // Partitioning the table, then two appends.
      retainedSnapshots: 3,
      partitionBy: ["day"],
      warnings: [{ code: "partitioned-small-dataset" }],
    })
    expect(described?.dataBytes).toBeGreaterThan(0)
    expect(described?.warnings[0]?.message).toContain("holds 53 rows")

    expect(orders).toMatchObject({ rowCount: 1, partitionBy: [], warnings: [] })
    expect(missing).toMatchObject({ datasetId: "never.created", materialized: false })
  })

  async function writeSnapshot(rows: readonly { orderId: string; total: number }[]) {
    return write(ordersDataset, "snapshot", rows)
  }

  async function useCatalog(catalog: "duckdb" | "sqlite"): Promise<void> {
    await storage.close()
    options = localDuckLakeOptions(await mkdtemp(join(rootDir, `${catalog}-`)), catalog)
    storage = new DuckLakeStorage(options)
  }

  async function write(
    dataset: DatasetDefinition,
    mode: "append" | "snapshot",
    rows: readonly DatasetRow[],
    provenance?: Pick<BeginDatasetWriteInput, "producer" | "lineage">
  ) {
    const write = await storage.beginWrite({
      dataset: withoutMarkings(dataset),
      mode,
      ...provenance,
    })
    await write.writeRows(rows)
    return write.commit()
  }

  /** Expires four versions of the orders, each holding a file, then backdates their schedule. */
  async function scheduleFiles(intervals: readonly string[]): Promise<void> {
    // Above DuckLake's inlining limit, each version writes a file.
    for (let total = 1; total <= 5; total++) {
      await writeSnapshot(Array.from({ length: 20 }, (_, n) => ({ orderId: `ord_${n}`, total })))
    }
    await backdateHistory("2 hours")
    await storage.maintenance.applyRetention(ONE_HOUR)

    expect(await scheduledFileCount()).toBe(4)
    await backdateScheduledFiles(intervals)
  }

  async function snapshotCount(): Promise<number> {
    return count("ducklake_snapshot")
  }

  async function scheduledFileCount(): Promise<number> {
    return count("ducklake_files_scheduled_for_deletion")
  }

  async function count(table: string): Promise<number> {
    const runtime = await internals(storage).connections.attachedRuntime()
    const [row] = await runtime.query(`
      SELECT count(*) AS row_count FROM ${duckLakeMetadataTableName(options, table)}
    `)

    return Number(row?.row_count ?? 0)
  }

  /**
   * Moves the catalog time of every snapshot, or of those up to `throughVersionId`, back by
   * `interval`, instead of waiting for them to age.
   */
  async function backdateHistory(interval: string, throughVersionId?: string): Promise<void> {
    const runtime = await internals(storage).connections.attachedRuntime()
    const through =
      throughVersionId === undefined
        ? ""
        : `WHERE snapshot_id <= ${parseVersionId(throughVersionId)}`

    await runtime.run(`
      UPDATE ${duckLakeMetadataTableName(options, "ducklake_snapshot")}
      SET snapshot_time = ${backdatedSql("snapshot_time", interval)}
      ${through}
    `)
  }

  /** Moves the schedule time of each file scheduled for deletion back, in file order. */
  async function backdateScheduledFiles(intervals: readonly string[]): Promise<void> {
    const runtime = await internals(storage).connections.attachedRuntime()
    const scheduled = duckLakeMetadataTableName(options, "ducklake_files_scheduled_for_deletion")
    const files = await runtime.query(`SELECT data_file_id FROM ${scheduled} ORDER BY data_file_id`)

    for (const [index, file] of files.entries()) {
      const interval = intervals[Math.min(index, intervals.length - 1)] ?? "0 seconds"
      await runtime.run(`
        UPDATE ${scheduled}
        SET schedule_start = ${backdatedSql("schedule_start", interval)}
        WHERE data_file_id = ${file.data_file_id}
      `)
    }
  }

  /** Stores a schedule time as text, as a SQLite catalog holds it. */
  async function storeScheduleTimes(
    text: string,
    { oneFile = false }: { readonly oneFile?: boolean } = {}
  ): Promise<void> {
    const runtime = await internals(storage).connections.attachedRuntime()
    const scheduled = duckLakeMetadataTableName(options, "ducklake_files_scheduled_for_deletion")
    const where = oneFile ? `WHERE data_file_id = (SELECT min(data_file_id) FROM ${scheduled})` : ""

    await runtime.run(`UPDATE ${scheduled} SET schedule_start = ${quoteSqlString(text)} ${where}`)
  }

  /** A SQLite catalog stores times as text with their UTC offset, as DuckDB renders them. */
  function backdatedSql(column: string, interval: string): string {
    const type = options.catalog.type === "sqlite" ? "VARCHAR" : "TIMESTAMPTZ"
    return `CAST(CAST(${column} AS TIMESTAMPTZ) - INTERVAL ${quoteSqlString(interval)} AS ${type})`
  }
})

/** The definition a lake stores: markings are a project concern. */
function withoutMarkings(dataset: DatasetDefinition): DatasetDefinition {
  return {
    ...dataset,
    schema: { columns: dataset.schema.columns.map(({ markings: _markings, ...column }) => column) },
  }
}

function internals(storage: DuckLakeStorage): DuckLakeStorageInternals {
  return storage as unknown as DuckLakeStorageInternals
}
