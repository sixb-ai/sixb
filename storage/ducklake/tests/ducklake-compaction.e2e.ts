import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { change, col, type DatasetDefinition, defineDataset } from "@sixb/core"
import type { DatasetVersion } from "@sixb/core/lake-storage"
import type { DuckLakeStorage } from "../src"
import type { DuckDbExclusiveRuntime } from "../src/internal/duckdb-runtime"
import { encodeDatasetSequenceTableName, encodeDatasetTableName } from "../src/internal/names"
import { quoteSqlString } from "../src/internal/sql"
import { collectRows, createLocalDuckLakeStorage } from "./test-utils"

interface DuckLakeStorageInternals {
  readonly connections: {
    withExclusiveAttached<T>(run: (runtime: DuckDbExclusiveRuntime) => Promise<T>): Promise<T>
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

describe("DuckLakeStorage compaction", () => {
  let rootDir: string
  let storage: DuckLakeStorage

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-compaction-"))
  })

  afterEach(async () => {
    await storage.close()
    await rm(rootDir, { recursive: true, force: true })
  })

  for (const catalog of ["duckdb", "sqlite"] as const) {
    // Regression proof: drop MAINTENANCE_CHANGE_KINDS from parseTableDataChange. The flush, which
    // records `deleted_from_table`, and the rewrite then each read as a new snapshot version.
    test(`${catalog}: DuckLake's own maintenance commits are never versions`, async () => {
      storage = createLocalDuckLakeStorage(rootDir, catalog)
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

      const before = await history()
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

      expect(await history()).toEqual(before)
      expect(
        await storage.listLatestVersionsSince({ cursor: cursor?.cursor ?? null })
      ).toMatchObject({ versions: [] })
    }, 30_000)
  }

  /** Every version of both datasets, with the rows each one reads. */
  async function history(): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {}

    for (const dataset of [items, accounts]) {
      const versions = await storage.listVersions(dataset.id)
      const latest = await storage.getLatestVersion(dataset.id)
      result[`${dataset.id} latest`] = latest?.versionId

      for (const version of versions) {
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

  /** Runs DuckLake's maintenance calls in one transaction, as any DuckLake client could. */
  async function maintain(calls: readonly string[]): Promise<void> {
    await (storage as unknown as DuckLakeStorageInternals).connections.withExclusiveAttached(
      async (runtime) => {
        await runtime.run("BEGIN TRANSACTION")
        for (const call of calls) {
          await runtime.run(call)
        }
        await runtime.run("COMMIT")
      }
    )
  }
})

function rows<T>(count: number, row: (index: number) => T): T[] {
  return Array.from({ length: count }, (_, index) => row(index))
}

function table(dataset: DatasetDefinition): string {
  return quoteSqlString(encodeDatasetTableName(dataset.id))
}

function sequenceTable(dataset: DatasetDefinition): string {
  return quoteSqlString(encodeDatasetSequenceTableName(dataset.id))
}
