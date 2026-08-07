import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { change, col, defineDataset } from "@sixb/core"
import { type DuckLakeStorage, DuckLakeStorage as DuckLakeStorageProvider } from "../src"
import { collectRows, createLocalDuckLakeStorage } from "./test-utils"

const ordersDataset = defineDataset("raw.erp.orders", {
  schema: [col("orderId", "string"), col("customerName", "string")],
})

const keyedOrdersDataset = defineDataset("raw.erp.keyed_orders", {
  schema: [col("orderId", "string"), col("customerName", "string")],
  primaryKey: "orderId",
})

describe("DuckLakeStorage optimistic concurrency", () => {
  let rootDir: string
  let storage: DuckLakeStorage
  const extraStorages: DuckLakeStorage[] = []

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-concurrency-"))
    storage = createLocalDuckLakeStorage(rootDir)
    await storage.createDataset(ordersDataset)
  })

  afterEach(async () => {
    await storage.close()
    for (const extraStorage of extraStorages.splice(0)) {
      await extraStorage.close()
    }
    await rm(rootDir, { recursive: true, force: true })
  })

  test("serializes concurrent metadata reads on one provider instance", async () => {
    const version = await seedInitialVersion(storage)

    const results = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const [dataset, latestVersion, versions] = await Promise.all([
          storage.getDataset(ordersDataset.id),
          storage.getLatestVersion(ordersDataset.id),
          storage.listVersions(ordersDataset.id),
        ])
        return { dataset, latestVersion, versions }
      })
    )

    for (const result of results) {
      expect(result.dataset?.id).toBe(ordersDataset.id)
      expect(result.latestVersion?.versionId).toBe(version.versionId)
      expect(result.versions.map((item) => item.versionId)).toEqual([version.versionId])
    }
  })

  test("rejects a stale guarded commit from an older write session", async () => {
    const initialVersion = await seedInitialVersion(storage)

    const delayedWrite = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "append",
    })
    await delayedWrite.writeRows([{ orderId: "ord_2", customerName: "Grace" }])

    const competingWrite = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "append",
    })
    await competingWrite.writeRows([{ orderId: "ord_3", customerName: "Katherine" }])
    const winningVersion = await competingWrite.commit({
      expectedLatestVersionId: initialVersion.versionId,
    })

    await expect(
      delayedWrite.commit({ expectedLatestVersionId: initialVersion.versionId })
    ).rejects.toThrow(
      `expected latest version '${initialVersion.versionId}', found '${winningVersion.versionId}'`
    )

    expect(await collectRows(storage.readRows({ datasetId: ordersDataset.id }))).toEqual([
      { orderId: "ord_1", customerName: "Ada" },
      { orderId: "ord_3", customerName: "Katherine" },
    ])
    expect(
      (await storage.listVersions(ordersDataset.id)).map((version) => version.versionId)
    ).toEqual([winningVersion.versionId, initialVersion.versionId])
  })

  test("rejects a stale guarded commit from another provider instance", async () => {
    const initialVersion = await seedInitialVersion(storage)
    const secondStorage = createLocalDuckLakeStorage(rootDir)
    extraStorages.push(secondStorage)

    const delayedWrite = await secondStorage.beginWrite({
      dataset: ordersDataset,
      mode: "append",
    })
    await delayedWrite.writeRows([{ orderId: "ord_2", customerName: "Grace" }])

    const competingWrite = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "append",
    })
    await competingWrite.writeRows([{ orderId: "ord_3", customerName: "Katherine" }])
    const winningVersion = await competingWrite.commit({
      expectedLatestVersionId: initialVersion.versionId,
    })

    await expect(
      delayedWrite.commit({ expectedLatestVersionId: initialVersion.versionId })
    ).rejects.toThrow("Optimistic commit failed")

    expect(await secondStorage.getLatestVersion(ordersDataset.id)).toMatchObject({
      versionId: winningVersion.versionId,
    })
    expect(await collectRows(storage.readRows({ datasetId: ordersDataset.id }))).toEqual([
      { orderId: "ord_1", customerName: "Ada" },
      { orderId: "ord_3", customerName: "Katherine" },
    ])
  })

  test("lets an attached local DuckDB peer observe another provider's commit", async () => {
    const secondStorage = createLocalDuckLakeStorage(rootDir)
    extraStorages.push(secondStorage)

    expect(await secondStorage.listDatasets()).toEqual([ordersDataset])

    const committedVersion = await seedInitialVersion(storage)

    await expect(secondStorage.getLatestVersion(ordersDataset.id)).resolves.toMatchObject({
      versionId: committedVersion.versionId,
    })
    await expect(
      collectRows(secondStorage.readRows({ datasetId: ordersDataset.id }))
    ).resolves.toEqual([{ orderId: "ord_1", customerName: "Ada" }])
  })

  test("coordinates local catalog peers with equivalent path spellings", async () => {
    await mkdir(join(rootDir, "alias"))
    const firstStorage = new DuckLakeStorageProvider({
      catalog: { type: "sqlite", path: join(rootDir, "metadata.sqlite") },
      dataPath: join(rootDir, "sqlite-data"),
    })
    const secondStorage = new DuckLakeStorageProvider({
      catalog: { type: "sqlite", path: `${rootDir}/alias/../metadata.sqlite` },
      dataPath: join(rootDir, "sqlite-data"),
    })
    extraStorages.push(firstStorage, secondStorage)

    await firstStorage.createDataset(ordersDataset)
    expect(await secondStorage.listDatasets()).toEqual([ordersDataset])

    const committedVersion = await seedInitialVersion(firstStorage)

    await expect(secondStorage.getLatestVersion(ordersDataset.id)).resolves.toMatchObject({
      versionId: committedVersion.versionId,
    })
  })

  test("does not report another session's concurrent commit as successful", async () => {
    await seedInitialVersion(storage)
    const secondStorage = createLocalDuckLakeStorage(rootDir)
    extraStorages.push(secondStorage)

    const firstWrite = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "append",
    })
    await firstWrite.writeRows([{ orderId: "ord_2", customerName: "Grace" }])

    const secondWrite = await secondStorage.beginWrite({
      dataset: ordersDataset,
      mode: "append",
    })
    await secondWrite.writeRows([{ orderId: "ord_3", customerName: "Katherine" }])

    const results = await Promise.allSettled([firstWrite.commit(), secondWrite.commit()])
    const fulfilled = results.filter((result) => result.status === "fulfilled")
    const fulfilledVersionIds = fulfilled.map((result) => result.value.versionId)

    expect(fulfilled.length).toBeGreaterThan(0)
    expect(new Set(fulfilledVersionIds).size).toBe(fulfilledVersionIds.length)

    const committedOrderIds = results.flatMap((result, index) =>
      result.status === "fulfilled" ? [`ord_${index + 2}`] : []
    )
    const rows = await collectRows(storage.readRows({ datasetId: ordersDataset.id }))
    expect(rows.map((row) => row.orderId).sort()).toEqual(["ord_1", ...committedOrderIds].sort())
  })

  test("lets only one provider commit a merge from the same absent base", async () => {
    await storage.createDataset(keyedOrdersDataset)
    const secondStorage = createLocalDuckLakeStorage(rootDir)
    extraStorages.push(secondStorage)

    const firstMerge = await storage.beginMerge({ dataset: keyedOrdersDataset })
    const secondMerge = await secondStorage.beginMerge({ dataset: keyedOrdersDataset })
    await firstMerge.writeChanges([change.upsert({ orderId: "ord_1", customerName: "Ada" })])
    await secondMerge.writeChanges([change.upsert({ orderId: "ord_2", customerName: "Grace" })])

    const results = await Promise.allSettled([firstMerge.commit(), secondMerge.commit()])

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    expect(await storage.listVersions(keyedOrdersDataset.id)).toHaveLength(1)
    expect(await collectRows(storage.readRows({ datasetId: keyedOrdersDataset.id }))).toHaveLength(
      1
    )
  })
})

async function seedInitialVersion(storage: DuckLakeStorage) {
  const write = await storage.beginWrite({
    dataset: ordersDataset,
    mode: "snapshot",
  })
  await write.writeRows([{ orderId: "ord_1", customerName: "Ada" }])
  return write.commit()
}
