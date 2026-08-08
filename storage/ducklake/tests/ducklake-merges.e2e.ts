import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { change, col, defineDataset } from "@sixb/core"
import type { DuckLakeStorage, DuckLakeStorageOptions } from "../src"
import type {
  DuckDbExclusiveRuntime,
  DuckDbQueryRuntime,
  DuckDbRuntime,
} from "../src/internal/duckdb-runtime"
import { encodeDatasetTableName } from "../src/internal/names"
import { duckLakeMetadataTableName, qualifiedTableName } from "../src/internal/sql"
import { collectRows, createLocalDuckLakeStorage, localDuckLakeOptions } from "./test-utils"

interface DuckLakeStorageInternals {
  readonly connections: {
    runtime(): Promise<DuckDbRuntime>
    withAttachedRuntime<T>(run: (runtime: DuckDbQueryRuntime) => Promise<T>): Promise<T>
  }
}

describe("DuckLakeStorage keyed merges", () => {
  let rootDir: string
  let options: DuckLakeStorageOptions
  let storage: DuckLakeStorage

  const invoices = defineDataset("raw.erp.merge_invoices", {
    schema: [
      col("id", "string"),
      col("status", "string"),
      col("note", "string", { nullable: true }),
    ],
    primaryKey: "id",
  })

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-merges-"))
    options = localDuckLakeOptions(rootDir)
    storage = createLocalDuckLakeStorage(rootDir)
    await storage.createDataset(invoices)
  })

  afterEach(async () => {
    await storage.close()
    await rm(rootDir, { recursive: true, force: true })
  })

  test("commits one snapshot and reopens complete merge version metadata", async () => {
    const snapshotsAfterCreate = await snapshotCount(storage, options)

    const initialNoOp = await storage.beginMerge({ dataset: invoices })
    expect(await initialNoOp.commit()).toEqual({ outcome: "unchanged", version: null })
    expect(await snapshotCount(storage, options)).toBe(snapshotsAfterCreate)

    const seed = await storage.beginWrite({ dataset: invoices, mode: "snapshot" })
    await seed.writeRows([
      { id: "inv_1", status: "open", note: null },
      { id: "inv_2", status: "open", note: null },
    ])
    const seedVersion = await seed.commit()
    const snapshotsAfterSeed = await snapshotCount(storage, options)

    const merge = await storage.beginMerge({
      dataset: invoices,
      producer: { kind: "sync", id: "sync-invoices", runId: "run_1" },
      inputs: [{ datasetId: "raw.erp.invoice_changes", versionId: "cursor_1" }],
    })
    await merge.writeChanges([
      change.upsert({ id: "inv_1", status: "paid", note: "settled" }),
      change.delete({ id: "inv_2" }),
      change.upsert({ id: "inv_3", status: "open", note: null }),
    ])
    const runtime = await internals(storage).connections.runtime()
    const { result, statements } = await captureExclusiveSql(runtime, () =>
      merge.commit({ commitMessage: "apply invoice changes" })
    )

    expect(result.outcome).toBe("created")
    if (result.outcome !== "created") {
      throw new Error("Expected DuckLake merge to create a version")
    }
    expect(result.version).toMatchObject({
      mode: "merge",
      parentVersionId: seedVersion.versionId,
      rowCount: 2,
      producer: { kind: "sync", id: "sync-invoices", runId: "run_1" },
      inputs: [{ datasetId: "raw.erp.invoice_changes", versionId: "cursor_1" }],
    })
    expect(await snapshotCount(storage, options)).toBe(snapshotsAfterSeed + 1)
    expect(await latestCommitMessage(storage, options)).toBe("apply invoice changes")
    expect(statements.filter((sql) => sql.includes("row_number() OVER"))).toHaveLength(1)
    expect(statements.some((sql) => sql.includes("max_key_count"))).toBe(false)
    expect(await temporaryMergeTableNames(storage)).toEqual([])
    await expect(
      collectRows(storage.readRows({ datasetId: invoices.id, versionId: seedVersion.versionId }))
    ).resolves.toEqual([
      { id: "inv_1", status: "open", note: null },
      { id: "inv_2", status: "open", note: null },
    ])

    const noOp = await storage.beginMerge({ dataset: invoices })
    await noOp.writeChanges([
      change.upsert({ id: "inv_1", status: "paid", note: "settled" }),
      change.delete({ id: "missing" }),
    ])
    expect(await noOp.commit()).toMatchObject({
      outcome: "unchanged",
      version: { versionId: result.version.versionId },
    })
    expect(await snapshotCount(storage, options)).toBe(snapshotsAfterSeed + 1)

    await storage.close()
    storage = createLocalDuckLakeStorage(rootDir)

    await expect(storage.getLatestVersion(invoices.id)).resolves.toMatchObject({
      versionId: result.version.versionId,
      mode: "merge",
      parentVersionId: seedVersion.versionId,
      rowCount: 2,
      producer: { kind: "sync", id: "sync-invoices", runId: "run_1" },
      inputs: [{ datasetId: "raw.erp.invoice_changes", versionId: "cursor_1" }],
    })
    await expect(collectRows(storage.readRows({ datasetId: invoices.id }))).resolves.toEqual([
      { id: "inv_1", status: "paid", note: "settled" },
      { id: "inv_3", status: "open", note: null },
    ])
  })

  test("rejects a corrupted duplicate baseline and cleans the staging table", async () => {
    const seed = await storage.beginWrite({ dataset: invoices, mode: "snapshot" })
    await seed.writeRows([{ id: "inv_1", status: "open", note: null }])
    await seed.commit()

    const table = qualifiedTableName(options, encodeDatasetTableName(invoices.id))
    await internals(storage).connections.withAttachedRuntime((runtime) =>
      runtime.run(`INSERT INTO ${table} VALUES ('inv_1', 'paid', NULL)`)
    )
    const versionsBeforeMerge = await storage.listVersions(invoices.id)

    const merge = await storage.beginMerge({ dataset: invoices })
    await merge.writeChanges([change.delete({ id: "inv_1" })])
    await expect(merge.commit()).rejects.toThrow("current baseline contains duplicate primary key")

    expect(await storage.listVersions(invoices.id)).toEqual(versionsBeforeMerge)
    await expect(collectRows(storage.readRows({ datasetId: invoices.id }))).resolves.toEqual([
      { id: "inv_1", status: "open", note: null },
      { id: "inv_1", status: "paid", note: null },
    ])
    expect(await temporaryMergeTableNames(storage)).toEqual([])
  })

  test("rolls back deletes when the matching insert fails", async () => {
    // Regression guard: the injected insert failure happens after merge deletes have run. Without
    // the shared transaction, inv_1 would disappear even though commit rejects.
    const seed = await storage.beginWrite({ dataset: invoices, mode: "snapshot" })
    await seed.writeRows([
      { id: "inv_1", status: "open", note: null },
      { id: "inv_2", status: "open", note: null },
    ])
    const seedVersion = await seed.commit()

    const merge = await storage.beginMerge({ dataset: invoices })
    await merge.writeChanges([
      change.upsert({ id: "inv_1", status: "paid", note: null }),
      change.upsert({ id: "inv_3", status: "open", note: null }),
    ])

    const runtime = await internals(storage).connections.runtime()
    const table = qualifiedTableName(options, encodeDatasetTableName(invoices.id))
    const insertError = new Error("simulated merge insert failure")
    const restoreRuntime = failNextInsert(runtime, table, insertError)
    try {
      await expect(merge.commit()).rejects.toBe(insertError)
    } finally {
      restoreRuntime()
    }

    expect(await storage.getLatestVersion(invoices.id)).toMatchObject({
      versionId: seedVersion.versionId,
    })
    expect(await storage.listVersions(invoices.id)).toHaveLength(1)
    await expect(collectRows(storage.readRows({ datasetId: invoices.id }))).resolves.toEqual([
      { id: "inv_1", status: "open", note: null },
      { id: "inv_2", status: "open", note: null },
    ])
    expect(await temporaryMergeTableNames(storage)).toEqual([])
  })

  test("preserves ordering across staging batches and writeChanges calls", async () => {
    const merge = await storage.beginMerge({ dataset: invoices })

    async function* changes() {
      for (let index = 0; index < 1_001; index += 1) {
        yield change.upsert({ id: `inv_${index}`, status: "open", note: null })
      }
    }

    await merge.writeChanges(changes())
    await merge.writeChanges([
      change.upsert({ id: "inv_0", status: "paid", note: null }),
      change.delete({ id: "inv_1000" }),
    ])
    const result = await merge.commit()

    expect(result).toMatchObject({ outcome: "created", version: { rowCount: 1_000 } })
    const rows = await collectRows(storage.readRows({ datasetId: invoices.id }))
    expect(rows).toHaveLength(1_000)
    expect(rows[0]).toEqual({ id: "inv_0", status: "paid", note: null })
    expect(rows.at(-1)).toEqual({ id: "inv_999", status: "open", note: null })
  })
})

function internals(storage: DuckLakeStorage): DuckLakeStorageInternals {
  return storage as unknown as DuckLakeStorageInternals
}

async function snapshotCount(
  storage: DuckLakeStorage,
  options: DuckLakeStorageOptions
): Promise<number> {
  return internals(storage).connections.withAttachedRuntime(async (runtime) => {
    const snapshots = duckLakeMetadataTableName(options, "ducklake_snapshot")
    const [row] = await runtime.query(`SELECT count(*) AS snapshot_count FROM ${snapshots}`)
    return Number(row?.snapshot_count ?? 0)
  })
}

async function latestCommitMessage(
  storage: DuckLakeStorage,
  options: DuckLakeStorageOptions
): Promise<string | null> {
  return internals(storage).connections.withAttachedRuntime(async (runtime) => {
    const snapshotChanges = duckLakeMetadataTableName(options, "ducklake_snapshot_changes")
    const [row] = await runtime.query(`
      SELECT commit_message
      FROM ${snapshotChanges}
      ORDER BY snapshot_id DESC
      LIMIT 1
    `)
    return typeof row?.commit_message === "string" ? row.commit_message : null
  })
}

async function temporaryMergeTableNames(storage: DuckLakeStorage): Promise<readonly string[]> {
  const runtime = await internals(storage).connections.runtime()
  const rows = await runtime.query(`
    SELECT table_name
    FROM duckdb_tables()
    WHERE temporary AND starts_with(table_name, 'sixb_merge_')
    ORDER BY table_name
  `)
  return rows.map((row) => String(row.table_name))
}

function failNextInsert(runtime: DuckDbRuntime, targetTable: string, error: Error): () => void {
  const originalWithExclusive = runtime.withExclusive.bind(runtime)
  let failed = false

  runtime.withExclusive = (useRuntime) =>
    originalWithExclusive((exclusiveRuntime) =>
      useRuntime(
        wrapExclusiveRuntime(exclusiveRuntime, async (sql, values) => {
          if (!failed && sql.includes(`INSERT INTO ${targetTable}`)) {
            failed = true
            throw error
          }
          await exclusiveRuntime.run(sql, values)
        })
      )
    )

  return () => {
    runtime.withExclusive = originalWithExclusive
  }
}

function wrapExclusiveRuntime(
  runtime: DuckDbExclusiveRuntime,
  run: DuckDbExclusiveRuntime["run"]
): DuckDbExclusiveRuntime {
  return {
    run,
    runStatements: (statements) => runtime.runStatements(statements),
    query: (sql, values) => runtime.query(sql, values),
    withAppender: (tableName, useAppender) => runtime.withAppender(tableName, useAppender),
  }
}

async function captureExclusiveSql<T>(
  runtime: DuckDbRuntime,
  run: () => Promise<T>
): Promise<{ readonly result: T; readonly statements: readonly string[] }> {
  const originalWithExclusive = runtime.withExclusive.bind(runtime)
  const statements: string[] = []

  runtime.withExclusive = (useRuntime) =>
    originalWithExclusive((exclusiveRuntime) =>
      useRuntime({
        run: async (sql, values) => {
          statements.push(sql)
          await exclusiveRuntime.run(sql, values)
        },
        runStatements: async (sqlStatements) => {
          statements.push(...sqlStatements)
          await exclusiveRuntime.runStatements(sqlStatements)
        },
        query: async (sql, values) => {
          statements.push(sql)
          return exclusiveRuntime.query(sql, values)
        },
        withAppender: (tableName, useAppender) =>
          exclusiveRuntime.withAppender(tableName, useAppender),
      })
    )

  try {
    return { result: await run(), statements }
  } finally {
    runtime.withExclusive = originalWithExclusive
  }
}
