import { afterEach, beforeEach, describe, expect, test } from "bun:test"
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
import { duckLakeMetadataTableName } from "../src/internal/sql"
import { collectRows, createLocalDuckLakeStorage, localDuckLakeOptions } from "./test-utils"

interface DuckLakeStorageInternals {
  readonly connections: {
    attachedRuntime(): Promise<{
      query(sql: string): Promise<readonly Record<string, unknown>[]>
    }>
  }
}

const ordersDataset = defineDataset("raw.maintenance.orders", {
  schema: [col("orderId", "string"), col("total", "int64")],
})

describe("DuckLakeStorage maintenance", () => {
  let rootDir: string
  let storage: DuckLakeStorage

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-maintenance-"))
    storage = createLocalDuckLakeStorage(rootDir)
    await storage.createDataset(ordersDataset)
  })

  afterEach(async () => {
    await storage.close()
    await rm(rootDir, { recursive: true, force: true })
  })

  test("dry-run maintenance reports counts without mutating snapshots", async () => {
    await writeSnapshot([{ orderId: "ord_1", total: 1 }])
    await writeSnapshot([{ orderId: "ord_2", total: 2 }])
    const snapshotsBefore = await duckLakeSnapshotCount(storage, localDuckLakeOptions(rootDir))

    const report = await storage.runMaintenance({
      dryRun: true,
      expireOlderThan: "0 seconds",
      deleteOlderThan: "0 seconds",
    })

    expect(report).toMatchObject({
      dryRun: true,
      expireOlderThan: "0 seconds",
      deleteOlderThan: "0 seconds",
    })
    expect(report.snapshots).toBeGreaterThanOrEqual(0)
    expect(report.oldFiles).toBeGreaterThanOrEqual(0)
    expect(report.orphanedFiles).toBeGreaterThanOrEqual(0)
    expect(await duckLakeSnapshotCount(storage, localDuckLakeOptions(rootDir))).toBe(
      snapshotsBefore
    )
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
    await storage.runMaintenance({ expireOlderThan: "0 seconds", deleteOlderThan: "0 seconds" })
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

  // Regression proof: in DuckLakeMaintenance, stop keeping each dataset's latest version. The
  // orders dataset, idle since another dataset wrote, then loses its only version.
  test("non-dry-run maintenance expires eligible snapshots and preserves latest data", async () => {
    await writeSnapshot([{ orderId: "ord_1", total: 1 }])
    const latest = await writeSnapshot([{ orderId: "ord_2", total: 2 }])
    const other = defineDataset("raw.maintenance.other", { schema: [col("id", "string")] })
    await storage.createDataset(other)
    await write(other, "snapshot", [{ id: "other_1" }])
    const snapshotsBefore = await duckLakeSnapshotCount(storage, localDuckLakeOptions(rootDir))

    const report = await storage.runMaintenance({
      expireOlderThan: "0 seconds",
      deleteOlderThan: "0 seconds",
    })

    expect(report).toMatchObject({
      dryRun: false,
      expireOlderThan: "0 seconds",
      deleteOlderThan: "0 seconds",
      keptSnapshots: 1,
    })
    expect(report.snapshots).toBeGreaterThan(0)
    expect(await duckLakeSnapshotCount(storage, localDuckLakeOptions(rootDir))).toBeLessThan(
      snapshotsBefore
    )
    expect((await storage.getLatestVersion(ordersDataset.id))?.versionId).toBe(latest.versionId)
    await expect(collectRows(storage.readRows({ datasetId: ordersDataset.id }))).resolves.toEqual([
      { orderId: "ord_2", total: "2" },
    ])
  })

  for (const catalog of ["duckdb", "sqlite"] as const) {
    // Regression proof: in DuckLakeMaintenance, stop keeping each dataset's latest version. The
    // idle dataset then has no version left, and its rows no version to read them through.
    test(`${catalog}: keeps the latest version of an idle dataset and expires the rest`, async () => {
      const idle = defineDataset("idle.rooms", { schema: [col("id", "string")] })
      const busy = defineDataset("busy.readings", { schema: [col("id", "string")] })
      await useCatalog(catalog)
      await storage.createDataset(idle)
      await storage.createDataset(busy)
      const idleVersion = await write(idle, "snapshot", [{ id: "room_1" }])
      const replaced = await write(busy, "snapshot", [{ id: "reading_1" }])
      await write(busy, "snapshot", [{ id: "reading_2" }])

      const report = await storage.runMaintenance({
        expireOlderThan: "0 seconds",
        deleteOlderThan: "0 seconds",
      })

      expect(report.keptSnapshots).toBe(1)
      expect((await storage.getLatestVersion(idle.id))?.versionId).toBe(idleVersion.versionId)
      expect(await collectRows(storage.readRows({ datasetId: idle.id }))).toEqual([
        { id: "room_1" },
      ])
      expect(await storage.getVersion(busy.id, replaced.versionId)).toBeNull()
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

      await storage.runMaintenance({ expireOlderThan: "0 seconds", deleteOlderThan: "0 seconds" })

      expect(await storage.getVersion(people.id, leaked.versionId)).toBeNull()
      const kept = await storage.getVersion(people.id, latest.versionId)
      expect(markings.classify(kept as DatasetVersion)).toEqual(before)
    })

    // Regression proof: in DuckLakeMaintenance, ignore `protect`. The version a projection applied
    // then expires.
    test(`${catalog}: keeps protected versions, reports kept snapshots, and reclaims the rest`, async () => {
      const options = await useCatalog(catalog)
      const rooms = defineDataset("rooms", { schema: [col("id", "string")] })
      await storage.createDataset(rooms)
      const rows = (prefix: string) =>
        Array.from({ length: 50 }, (_, index) => ({ id: `${prefix}_${index}` }))
      const replaced = await write(rooms, "snapshot", rows("a"))
      const applied = await write(rooms, "snapshot", rows("b"))
      const appended = await write(rooms, "append", rows("c"))
      await write(rooms, "snapshot", rows("d"))
      const snapshotsBefore = await duckLakeSnapshotCount(storage, options)
      const maintenance = {
        expireOlderThan: "0 seconds",
        deleteOlderThan: "0 seconds",
        protect: [{ datasetId: rooms.id, versionId: applied.versionId }],
      }

      const preview = await storage.runMaintenance({ ...maintenance, dryRun: true })
      expect(await duckLakeSnapshotCount(storage, options)).toBe(snapshotsBefore)
      const report = await storage.runMaintenance(maintenance)

      expect(preview).toMatchObject({ dryRun: true, keptSnapshots: 1 })
      expect(report).toMatchObject({ dryRun: false, keptSnapshots: 1 })
      expect(preview.snapshots).toBe(report.snapshots)
      expect(snapshotsBefore - (await duckLakeSnapshotCount(storage, options))).toBe(
        report.snapshots
      )
      expect(report.oldFiles).toBeGreaterThan(0)
      expect(await storage.getVersion(rooms.id, replaced.versionId)).toBeNull()
      expect(await storage.getVersion(rooms.id, appended.versionId)).toBeNull()
      expect(
        await collectRows(storage.readRows({ datasetId: rooms.id, versionId: applied.versionId }))
      ).toEqual(rows("b"))
    })

    // Regression proof: select old snapshots with DuckLake's own `older_than` (dry run) in
    // DuckLakeMaintenance.snapshotsOlderThan. On SQLite, run outside UTC (DuckLake 415a9ebd), the
    // version written a moment ago then expires.
    test(`${catalog}: expires only snapshots older than the retention`, async () => {
      const rooms = defineDataset("rooms", { schema: [col("id", "string")] })
      await useCatalog(catalog)
      await storage.createDataset(rooms)
      const old = await write(rooms, "snapshot", [{ id: "a" }])
      await Bun.sleep(2_000)
      const recent = await write(rooms, "snapshot", [{ id: "b" }])
      await write(rooms, "snapshot", [{ id: "c" }])

      await storage.runMaintenance({ expireOlderThan: "1 second" })

      expect(await storage.getVersion(rooms.id, old.versionId)).toBeNull()
      expect(await storage.getVersion(rooms.id, recent.versionId)).not.toBeNull()
    })
  }

  test("rejects a protected version that is not a DuckLake version", async () => {
    await expect(
      storage.runMaintenance({
        dryRun: true,
        protect: [{ datasetId: ordersDataset.id, versionId: "ver_1" }],
      })
    ).rejects.toThrow("Cannot protect version 'ver_1'")
  })

  test("maintenance targets the configured DuckLake alias", async () => {
    await storage.close()

    const options = {
      ...localDuckLakeOptions(rootDir),
      alias: "custom_lake",
    } satisfies DuckLakeStorageOptions
    storage = new DuckLakeStorage(options)
    await storage.createDataset(ordersDataset)
    await writeSnapshot([{ orderId: "ord_1", total: 1 }])
    await writeSnapshot([{ orderId: "ord_2", total: 2 }])
    const snapshotsBefore = await duckLakeSnapshotCount(storage, options)

    const report = await storage.runMaintenance({
      expireOlderThan: "0 seconds",
      deleteOlderThan: "0 seconds",
    })

    expect(report.snapshots).toBeGreaterThan(0)
    expect(await duckLakeSnapshotCount(storage, options)).toBeLessThan(snapshotsBefore)
  })

  test("maintenance rejects new work after storage closes", async () => {
    await storage.close()

    await expect(storage.runMaintenance({ dryRun: true })).rejects.toThrow("closed")
  })

  async function writeSnapshot(rows: readonly { orderId: string; total: number }[]) {
    return write(ordersDataset, "snapshot", rows)
  }

  async function useCatalog(catalog: "duckdb" | "sqlite"): Promise<DuckLakeStorageOptions> {
    await storage.close()
    const options = localDuckLakeOptions(await mkdtemp(join(rootDir, `${catalog}-`)), catalog)
    storage = new DuckLakeStorage(options)
    return options
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
})

/** The definition a lake stores: markings are a project concern. */
function withoutMarkings(dataset: DatasetDefinition): DatasetDefinition {
  return {
    ...dataset,
    schema: { columns: dataset.schema.columns.map(({ markings: _markings, ...column }) => column) },
  }
}

async function duckLakeSnapshotCount(
  storage: DuckLakeStorage,
  options: DuckLakeStorageOptions
): Promise<number> {
  const runtime = await (
    storage as unknown as DuckLakeStorageInternals
  ).connections.attachedRuntime()
  const [row] = await runtime.query(`
    SELECT count(*) AS row_count
    FROM ${duckLakeMetadataTableName(options, "ducklake_snapshot")}
  `)

  return Number(row?.row_count ?? 0)
}
