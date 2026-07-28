import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DatasetRow } from "@sixb/core"
import { col, defineDataset } from "@sixb/core"
import { runLakeStorageContractSuite } from "@sixb/core/testing"
import type { DuckLakeStorage } from "../src"
import { createLocalDuckLakeStorage } from "./test-utils"

const roots = new WeakMap<DuckLakeStorage, string>()

runLakeStorageContractSuite("DuckLakeStorage LakeStorage contract", {
  schemaEvolution: "addNullableColumns",
  missingVersionId: "ducklake:999999",
  async createStorage() {
    const rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-contract-"))
    const storage = createLocalDuckLakeStorage(rootDir)
    roots.set(storage, rootDir)
    return storage
  },
  async teardown(storage) {
    await storage.close()

    const rootDir = roots.get(storage)
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true })
    }
  },
})

describe("DuckLakeStorage stable pinned reads", () => {
  test("preserves physical row order and offsets after reopening", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-reopen-order-"))
    let storage = createLocalDuckLakeStorage(rootDir)
    try {
      const dataset = defineDataset("stable.reopen-order", {
        schema: [col("id", "string"), col("position", "int64")],
      })
      const expected = [
        { id: "third", position: "3" },
        { id: "first", position: "1" },
        { id: "fourth", position: "4" },
        { id: "second", position: "2" },
      ]
      await storage.createDataset(dataset)
      const write = await storage.beginWrite({ dataset, mode: "snapshot" })
      await write.writeRows(expected)
      const version = await write.commit()
      await storage.close()

      storage = createLocalDuckLakeStorage(rootDir)
      const pinned = { datasetId: dataset.id, versionId: version.versionId }
      await expect(collectRows(storage.readRows(pinned))).resolves.toEqual(expected)
      await expect(collectRows(storage.readRows({ ...pinned, offset: 2 }))).resolves.toEqual(
        expected.slice(2)
      )
    } finally {
      await storage.close()
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})

async function collectRows(rows: AsyncIterable<DatasetRow>): Promise<DatasetRow[]> {
  const collected: DatasetRow[] = []
  for await (const row of rows) collected.push(row)
  return collected
}
