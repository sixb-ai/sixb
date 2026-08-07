import { describe, expect, test } from "bun:test"
import { appendFile, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { col, type DatasetRow, defineDataset } from "@sixb/core"
import { runLakeMergeStorageContractSuite, runLakeStorageContractSuite } from "@sixb/core/testing"
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

runLakeMergeStorageContractSuite("LocalLakeStorage merge contract", {
  async createStorage() {
    const rootDir = await mkdtemp(join(tmpdir(), "sixb-lake-local-merge-contract-"))
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

describe("LocalLakeStorage merge persistence", () => {
  test("reopens merge versions and cleans stale session files", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "sixb-lake-local-reopen-merge-"))
    const path = join(rootDir, "lake")
    const dataset = defineDataset("stable.reopen-merge", {
      schema: [col("id", "string"), col("status", "string")],
      primaryKey: "id",
    })

    try {
      const storage = new LocalLakeStorage({ path })
      await storage.createDataset(dataset)
      const first = await storage.beginMerge({ dataset })
      const stale = await storage.beginMerge({ dataset })
      await first.writeChanges([{ kind: "upsert", row: { id: "inv_1", status: "open" } }])
      const commit = await first.commit()
      await stale.writeChanges([{ kind: "upsert", row: { id: "inv_2", status: "open" } }])
      await expect(stale.commit()).rejects.toThrow("Optimistic merge commit failed")

      const reopened = new LocalLakeStorage({ path })
      expect(await reopened.getLatestVersion(dataset.id)).toMatchObject({
        versionId: commit.version?.versionId,
        mode: "merge",
        rowCount: 1,
      })
      await expect(collectRows(reopened.readRows({ datasetId: dataset.id }))).resolves.toEqual([
        { id: "inv_1", status: "open" },
      ])

      expect(await readdir(join(path, ".tmp"))).toEqual([])
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  test("rejects an ambiguous persisted keyed baseline", async () => {
    // Regression guard: removing the baseline duplicate check allows the merge to silently choose
    // one of these rows and makes the rejected-commit assertion fail.
    const rootDir = await mkdtemp(join(tmpdir(), "sixb-lake-local-ambiguous-merge-"))
    const path = join(rootDir, "lake")
    const dataset = defineDataset("stable.ambiguous-merge", {
      schema: [col("id", "string"), col("status", "string")],
      primaryKey: "id",
    })

    try {
      const storage = new LocalLakeStorage({ path })
      await storage.createDataset(dataset)
      const seed = await storage.beginWrite({ dataset, mode: "snapshot" })
      await seed.writeRows([{ id: "inv_1", status: "open" }])
      const seedVersion = await seed.commit()
      const rowsPath = join(
        path,
        "datasets",
        encodeURIComponent(dataset.id),
        "rows",
        `${encodeURIComponent(seedVersion.versionId)}.jsonl`
      )
      await appendFile(rowsPath, `${JSON.stringify({ id: "inv_1", status: "paid" })}\n`, "utf8")

      const merge = await storage.beginMerge({ dataset })
      await merge.writeChanges([{ kind: "delete", key: { id: "inv_1" } }])
      await expect(merge.commit()).rejects.toThrow("contains duplicate primary key")

      expect(await storage.listVersions(dataset.id)).toHaveLength(1)
      expect(await readdir(join(path, ".tmp"))).toEqual([])
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
