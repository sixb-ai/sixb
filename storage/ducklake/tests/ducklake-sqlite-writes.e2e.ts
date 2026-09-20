import { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { change, col, defineDataset } from "@sixb/core"
import { LakeConcurrencyError } from "@sixb/core/lake-storage"
import { DuckLakeStorage, type DuckLakeStorageOptions } from "../src"
import { createDuckDbRuntime, setupDuckLake } from "../src/internal/duckdb-runtime"
import type { DuckLakeSnapshotReader } from "../src/internal/ducklake-snapshot-reader"
import { encodeDatasetTableName } from "../src/internal/names"
import { qualifiedTableName } from "../src/internal/sql"
import { collectRows } from "./test-utils"

const dataset = defineDataset("sqlite.synthetic", {
  schema: [col("id", "string"), col("value", "int64")],
  primaryKey: "id",
})

// Red check (DuckDB 1.5.2 / DuckLake 415a9ebd): restore the parent's write coordinator.
// Append, guarded writes, merge and empty initial writes fail at COMMIT: database is locked.
describe("DuckLake SQLite writes", () => {
  let rootDir: string
  let options: DuckLakeStorageOptions
  let storage: DuckLakeStorage

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-sqlite-writes-"))
    options = {
      catalog: { type: "sqlite", path: join(rootDir, "catalog.sqlite") },
      dataPath: join(rootDir, "data"),
      duckdb: { config: { threads: "1" } },
    }
    storage = new DuckLakeStorage(options)
    await storage.createDataset(dataset)
  })

  afterEach(async () => {
    await storage.close()
    await rm(rootDir, { recursive: true, force: true })
  })

  test("appends, replaces and merges while preserving historical versions after reopen", async () => {
    const seed = await storage.beginWrite({ dataset })
    await seed.writeRows([{ id: "1", value: 1 }])
    const first = await seed.commit()
    const append = await storage.beginWrite({ dataset, mode: "append" })
    await append.writeRows([{ id: "2", value: 2 }])
    const second = await append.commit({ expectedLatestVersionId: first.versionId })
    expect(second).toMatchObject({ parentVersionId: first.versionId, rowCount: 2 })

    const merge = await storage.beginMerge({ dataset })
    await merge.writeChanges([change.upsert({ id: "1", value: 10 }), change.delete({ id: "2" })])
    const merged = await merge.commit()
    expect(merged).toMatchObject({
      outcome: "created",
      version: { parentVersionId: second.versionId, rowCount: 1 },
    })
    const replace = await storage.beginWrite({ dataset })
    await replace.writeRows([{ id: "3", value: 3 }])
    const latest = await storage.getLatestVersion(dataset.id)
    const replaced = await replace.commit({ expectedLatestVersionId: latest!.versionId })
    await storage.close()
    storage = new DuckLakeStorage(options)
    expect(await collectRows(storage.readRows({ datasetId: dataset.id }))).toEqual([
      { id: "3", value: "3" },
    ])
    expect(
      await collectRows(storage.readRows({ datasetId: dataset.id, versionId: second.versionId }))
    ).toEqual([
      { id: "1", value: "1" },
      { id: "2", value: "2" },
    ])
    expect((await storage.listVersions(dataset.id)).map((version) => version.versionId)).toEqual([
      replaced.versionId,
      latest!.versionId,
      second.versionId,
      first.versionId,
    ])
    const catalog = new Database(join(rootDir, "catalog.sqlite"), { readonly: true })
    try {
      expect(catalog.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" })
    } finally {
      catalog.close()
    }
  })

  for (const mode of ["snapshot", "append"] as const) {
    test(`${mode}: initial empty version, no-op and changed input lineage`, async () => {
      const first = await (await storage.beginWrite({ dataset, mode })).commit()
      expect(first.outcome).toBe("created")
      const unchanged = await (await storage.beginWrite({ dataset, mode })).commit()
      expect(unchanged).toMatchObject({ outcome: "unchanged", versionId: first.versionId })
      const inputs = [{ datasetId: "source", versionId: "source:2" }]
      const advanced = await (await storage.beginWrite({ dataset, mode, inputs })).commit()
      expect(advanced).toMatchObject({ outcome: "created", inputs })
      expect(advanced.parentVersionId).toBe(mode === "append" ? first.versionId : undefined)
      expect(await collectRows(storage.readRows({ datasetId: dataset.id }))).toEqual([])
    })
  }

  test("empty initial merge stays a no-op unless a first version is requested", async () => {
    expect(await (await storage.beginMerge({ dataset })).commit()).toEqual({
      outcome: "unchanged",
      version: null,
    })
    expect(
      await (await storage.beginMerge({ dataset })).commit({ createInitialVersion: true })
    ).toMatchObject({
      outcome: "created",
      version: { rowCount: 0 },
    })
  })

  test("also supports SQLite through a custom catalog URI", async () => {
    await storage.close()
    storage = new DuckLakeStorage({
      ...options,
      catalog: {
        type: "custom",
        uri: `sqlite:${join(rootDir, "catalog.sqlite")}`,
        extensions: ["sqlite"],
      },
    })
    const first = await (await storage.beginWrite({ dataset })).commit()
    const append = await storage.beginWrite({ dataset, mode: "append" })
    await append.writeRows([{ id: "1", value: 1 }])
    expect(await append.commit({ expectedLatestVersionId: first.versionId })).toMatchObject({
      outcome: "created",
      rowCount: 1,
    })
  })

  test("rejects stale guards and duplicate keys without publishing partial changes", async () => {
    const seed = await storage.beginWrite({ dataset })
    await seed.writeRows([{ id: "1", value: 1 }])
    const first = await seed.commit()
    const stale = await storage.beginWrite({ dataset, mode: "append" })
    await stale.writeRows([{ id: "stale", value: 0 }])
    const append = await storage.beginWrite({ dataset, mode: "append" })
    await append.writeRows([{ id: "2", value: 2 }])
    const second = await append.commit()
    await expect(stale.commit({ expectedLatestVersionId: first.versionId })).rejects.toBeInstanceOf(
      LakeConcurrencyError
    )
    const duplicate = await storage.beginWrite({ dataset, mode: "append" })
    await duplicate.writeRows([{ id: "1", value: 10 }])
    await expect(duplicate.commit()).rejects.toThrow("primary key")
    expect((await storage.getLatestVersion(dataset.id))?.versionId).toBe(second.versionId)
    expect(await collectRows(storage.readRows({ datasetId: dataset.id }))).toEqual([
      { id: "1", value: "1" },
      { id: "2", value: "2" },
    ])
  })

  for (const journal of ["delete", "wal"] as const) {
    for (const guarded of [false, true]) {
      test(`${journal}: ${guarded ? "rejects a stale guard" : "refreshes an append"} when another engine commits during preparation`, async () => {
        // Red check: bypass the current_snapshot equality check in beginVersionTransaction.
        // The guarded write then succeeds against a version that is already stale.
        const seed = await storage.beginWrite({ dataset })
        await seed.writeRows([{ id: "1", value: 1 }])
        const first = await seed.commit()
        const catalog = new Database(join(rootDir, "catalog.sqlite"))
        try {
          catalog.run(`PRAGMA journal_mode=${journal}`)
        } finally {
          catalog.close()
        }
        const append = await storage.beginWrite({ dataset, mode: "append" })
        await append.writeRows([{ id: "local", value: 3 }])
        const external = await createDuckDbRuntime({ config: { threads: "1" } })
        const snapshots = (storage as unknown as { snapshotReader: DuckLakeSnapshotReader })
          .snapshotReader
        const original = snapshots.getLatestVersionSummaryForDefinition.bind(snapshots)
        let preparations = 0
        const table = qualifiedTableName(options, encodeDatasetTableName(dataset.id))
        const read = spyOn(snapshots, "getLatestVersionSummaryForDefinition").mockImplementation(
          async (...args) => {
            const summary = await original(...args)
            if (++preparations === 1)
              await external.run(`INSERT INTO ${table} VALUES ('external', 2)`)
            return summary
          }
        )
        try {
          await setupDuckLake(external, options)
          if (guarded) {
            await expect(
              append.commit({ expectedLatestVersionId: first.versionId })
            ).rejects.toBeInstanceOf(LakeConcurrencyError)
          } else {
            const version = await append.commit()
            expect(version.parentVersionId).not.toBe(first.versionId)
            expect(version.parentVersionId).toBeDefined()
          }
          expect(preparations).toBe(2)
          const ids = (await collectRows(storage.readRows({ datasetId: dataset.id }))).map(
            (row) => row.id
          )
          expect(ids).toEqual(guarded ? ["1", "external"] : ["1", "external", "local"])
        } finally {
          read.mockRestore()
          await external.close()
        }
      })
    }
  }

  test("bounds preparation retries and leaves the provider usable", async () => {
    const append = await storage.beginWrite({ dataset, mode: "append" })
    await append.writeRows([{ id: "local", value: 1 }])
    const external = await createDuckDbRuntime({ config: { threads: "1" } })
    const snapshots = (storage as unknown as { snapshotReader: DuckLakeSnapshotReader })
      .snapshotReader
    const original = snapshots.getLatestVersionSummaryForDefinition.bind(snapshots)
    let preparations = 0
    const read = spyOn(snapshots, "getLatestVersionSummaryForDefinition").mockImplementation(
      async (...args) => {
        const summary = await original(...args)
        await external.run(
          `INSERT INTO ${qualifiedTableName(options, encodeDatasetTableName(dataset.id))} VALUES ('external-${++preparations}', 0)`
        )
        return summary
      }
    )
    try {
      await setupDuckLake(external, options)
      await expect(append.commit()).rejects.toThrow("three write preparations")
      expect(preparations).toBe(3)
    } finally {
      read.mockRestore()
      await external.close()
    }
    const retry = await storage.beginWrite({ dataset, mode: "append" })
    await retry.writeRows([{ id: "local", value: 1 }])
    await retry.commit()
    expect(
      (await collectRows(storage.readRows({ datasetId: dataset.id }))).map((row) => row.id)
    ).toEqual(["external-1", "external-2", "external-3", "local"])
  })
})
