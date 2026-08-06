import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { col, type DatasetRow, defineDataset } from "@sixb/core"
import { runLakeStorageContractSuite } from "@sixb/core/testing"
import { LocalLakeStorage } from "../src"

const roots = new WeakMap<LocalLakeStorage, string>()

runLakeStorageContractSuite("LocalLakeStorage", {
  async createStorage() {
    const rootDir = await mkdtemp(join(tmpdir(), "sixb-lake-local-contract-"))
    const storage = new LocalLakeStorage({ path: join(rootDir, "lake") })
    roots.set(storage, rootDir)
    return storage
  },
  async teardown(storage) {
    const rootDir = roots.get(storage)
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true })
    }
  },
})

describe("LocalLakeStorage definition persistence", () => {
  test("round-trips a keyed definition after reopening", async () => {
    // Regression guard: stripping primaryKey from definition.json makes the reopened reads fail.
    const rootDir = await mkdtemp(join(tmpdir(), "sixb-lake-local-reopen-definition-"))
    const path = join(rootDir, "lake")
    try {
      const dataset = defineDataset("stable.reopen-definition", {
        schema: [col("tenantId", "string"), col("invoiceId", "string"), col("status", "string")],
        primaryKey: ["tenantId", "invoiceId"],
      })
      const initial = new LocalLakeStorage({ path })
      await initial.createDataset(dataset)

      const reopened = new LocalLakeStorage({ path })

      await expect(reopened.getDataset(dataset.id)).resolves.toEqual(dataset)
      await expect(reopened.listDatasets()).resolves.toEqual([dataset])
      await expect(reopened.createDataset(dataset)).resolves.toEqual(dataset)
      await expect(reopened.listVersions(dataset.id)).resolves.toEqual([])
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})

describe("LocalLakeStorage stable pinned reads", () => {
  test("preserves physical row order and offsets after reopening", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "sixb-lake-local-reopen-order-"))
    const path = join(rootDir, "lake")
    try {
      const dataset = defineDataset("stable.reopen-order", {
        schema: [col("id", "string"), col("position", "int64")],
      })
      const expected = [
        { id: "third", position: 3 },
        { id: "first", position: 1 },
        { id: "fourth", position: 4 },
        { id: "second", position: 2 },
      ]
      const initial = new LocalLakeStorage({ path })
      await initial.createDataset(dataset)
      const write = await initial.beginWrite({ dataset, mode: "snapshot" })
      await write.writeRows(expected)
      const version = await write.commit()

      const reopened = new LocalLakeStorage({ path })
      const pinned = { datasetId: dataset.id, versionId: version.versionId }
      await expect(collectRows(reopened.readRows(pinned))).resolves.toEqual(expected)
      await expect(collectRows(reopened.readRows({ ...pinned, offset: 2 }))).resolves.toEqual(
        expected.slice(2)
      )
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})

async function collectRows(rows: AsyncIterable<DatasetRow>): Promise<DatasetRow[]> {
  const collected: DatasetRow[] = []
  for await (const row of rows) collected.push(row)
  return collected
}
