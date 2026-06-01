import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { col, defineDataset } from "@sixb/core"
import type { DuckLakeStorage } from "../src"
import { duckLakeMetadataTableName } from "../src/internal/sql"
import { createLocalDuckLakeStorage, localDuckLakeOptions } from "./test-utils"

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
    const snapshotsBefore = await duckLakeSnapshotCount(storage, rootDir)

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
    expect(await duckLakeSnapshotCount(storage, rootDir)).toBe(snapshotsBefore)
  })

  test("non-dry-run maintenance checkpoints an attached lake", async () => {
    await writeSnapshot([{ orderId: "ord_1", total: 1 }])

    const report = await storage.runMaintenance({
      expireOlderThan: "7 days",
    })

    expect(report).toMatchObject({
      dryRun: false,
      expireOlderThan: "7 days",
      deleteOlderThan: "7 days",
    })
    expect(await storage.getLatestVersion(ordersDataset.id)).not.toBeNull()
  })

  test("maintenance rejects new work after storage closes", async () => {
    await storage.close()

    await expect(storage.runMaintenance({ dryRun: true })).rejects.toThrow("closed")
  })

  async function writeSnapshot(rows: readonly { orderId: string; total: number }[]): Promise<void> {
    const write = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "snapshot",
    })
    await write.writeRows(rows)
    await write.commit()
  }
})

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
