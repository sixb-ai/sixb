import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { col, type DatasetRow, defineDataset } from "@pario/core"
import type { DuckLakeStorage } from "../src"
import type { DuckLakeSnapshotReader } from "../src/internal/ducklake-snapshot-reader"
import { collectRows, createLocalDuckLakeStorage } from "./test-utils"

interface DuckLakeStorageInternals {
  readonly snapshotReader: {
    getLatestVersionForDefinition: DuckLakeSnapshotReader["getLatestVersionForDefinition"]
  }
}

describe("DuckLakeStorage writes and latest reads", () => {
  let rootDir: string
  let storage: DuckLakeStorage

  const ordersDataset = defineDataset("raw.erp.orders", {
    schema: [
      col("orderId", "string"),
      col("customerName", "string"),
      col("orderCount", "int64"),
      col("metadata", "json", { nullable: true }),
    ],
    description: "ERP orders",
  })

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pario-ducklake-writes-"))
    storage = createLocalDuckLakeStorage(rootDir)
    await storage.createDataset(ordersDataset)
  })

  afterEach(async () => {
    await storage.close()
    await rm(rootDir, { recursive: true, force: true })
  })

  test("commits snapshot and append writes and reads the latest rows", async () => {
    const snapshotWrite = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "snapshot",
      producer: { kind: "sync", id: "erp-sync", runId: "run_1" },
    })

    await snapshotWrite.writeRows([{ orderId: "ord_1", customerName: "Ada", orderCount: 1 }])
    await snapshotWrite.writeRows([
      {
        orderId: "ord_2",
        customerName: "Grace",
        orderCount: "2",
        metadata: { source: "erp" },
      },
    ])

    const version1 = await snapshotWrite.commit({ commitMessage: "snapshot orders" })
    const latestAfterSnapshot = await storage.getLatestVersion("raw.erp.orders")

    expect(version1.versionId).toStartWith("ducklake:")
    expect(version1.mode).toBe("snapshot")
    expect(version1.rowCount).toBe(2)
    expect(version1.producer).toEqual({ kind: "sync", id: "erp-sync", runId: "run_1" })
    expect(latestAfterSnapshot?.versionId).toBe(version1.versionId)
    expect(await storage.getVersion("raw.erp.orders", version1.versionId)).toMatchObject({
      datasetId: "raw.erp.orders",
      versionId: version1.versionId,
      mode: "snapshot",
      rowCount: 2,
    })

    const appendWrite = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "append",
      inputs: [{ datasetId: "raw.erp.orders", versionId: version1.versionId }],
    })

    await appendWrite.writeRows([{ orderId: "ord_3", customerName: "Katherine", orderCount: 3 }])
    const version2 = await appendWrite.commit()

    expect(version2.versionId).toStartWith("ducklake:")
    expect(version2.parentVersionId).toBe(version1.versionId)
    expect(version2.rowCount).toBe(3)
    expect(version2.inputs).toEqual([
      { datasetId: "raw.erp.orders", versionId: version1.versionId },
    ])
    expect((await storage.getLatestVersion("raw.erp.orders"))?.versionId).toBe(version2.versionId)

    const latestRows = await collectRows(storage.readRows({ datasetId: "raw.erp.orders" }))
    expect(latestRows).toEqual([
      { orderId: "ord_1", customerName: "Ada", orderCount: "1", metadata: null },
      { orderId: "ord_2", customerName: "Grace", orderCount: "2", metadata: { source: "erp" } },
      { orderId: "ord_3", customerName: "Katherine", orderCount: "3", metadata: null },
    ])
  })

  test("supports projected latest reads with limits", async () => {
    const write = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "snapshot",
    })

    await write.writeRows([
      { orderId: "ord_1", customerName: "Ada", orderCount: 1 },
      { orderId: "ord_2", customerName: "Grace", orderCount: 2 },
    ])
    const version = await write.commit()

    await expect(
      collectRows(storage.readRows({ datasetId: "raw.erp.orders", columns: ["missing"] }))
    ).rejects.toThrow("does not have column 'missing'")

    expect(
      await collectRows(
        storage.readRows({
          datasetId: "raw.erp.orders",
          columns: ["orderId"],
          limit: 1,
        })
      )
    ).toEqual([{ orderId: "ord_1" }])
    expect(
      await collectRows(
        storage.readRows({ datasetId: "raw.erp.orders", versionId: version.versionId })
      )
    ).toEqual([
      { orderId: "ord_1", customerName: "Ada", orderCount: "1", metadata: null },
      { orderId: "ord_2", customerName: "Grace", orderCount: "2", metadata: null },
    ])
  })

  test("supports breaking out of streamed reads without blocking later reads", async () => {
    const write = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "snapshot",
    })

    await write.writeRows([
      { orderId: "ord_1", customerName: "Ada", orderCount: 1 },
      { orderId: "ord_2", customerName: "Grace", orderCount: 2 },
    ])
    await write.commit()

    for await (const row of storage.readRows({ datasetId: ordersDataset.id })) {
      expect(row.orderId).toBe("ord_1")
      break
    }

    await expect(
      collectRows(storage.readRows({ datasetId: ordersDataset.id }))
    ).resolves.toHaveLength(2)
  })

  test("writes large row streams through the appender staging path", async () => {
    const ROW_COUNT = 1001

    const rows = Array.from({ length: ROW_COUNT }, (_, index) => ({
      orderId: `ord_${index + 1}`,
      customerName: `Customer ${index + 1}`,
      orderCount: index + 1,
    }))

    const write = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "snapshot",
    })
    await write.writeRows(rows)
    const version = await write.commit()

    expect(version.rowCount).toBe(ROW_COUNT)

    const persisted = await collectRows(storage.readRows({ datasetId: ordersDataset.id }))
    expect(persisted).toHaveLength(ROW_COUNT)
    expect(persisted[0]).toEqual({
      orderId: "ord_1",
      customerName: "Customer 1",
      orderCount: "1",
      metadata: null,
    })
    expect(persisted[500]).toEqual({
      orderId: "ord_501",
      customerName: "Customer 501",
      orderCount: "501",
      metadata: null,
    })
    expect(persisted[ROW_COUNT - 1]).toEqual({
      orderId: `ord_${ROW_COUNT}`,
      customerName: `Customer ${ROW_COUNT}`,
      orderCount: String(ROW_COUNT),
      metadata: null,
    })
  })

  test("appends streamed rows before reusable row objects mutate again", async () => {
    function* reusedOrderRows(): Iterable<DatasetRow> {
      const metadata: Record<string, unknown> = {
        source: "erp",
        sequence: 0,
      }
      const row: Record<string, unknown> = {
        orderId: "",
        customerName: "",
        orderCount: 0,
        metadata,
      }

      for (const values of [
        {
          orderId: "ord_1",
          customerName: "Ada",
          orderCount: 1,
          sequence: 1,
        },
        {
          orderId: "ord_2",
          customerName: "Grace",
          orderCount: 2,
          sequence: 2,
        },
        {
          orderId: "ord_3",
          customerName: "Katherine",
          orderCount: 3,
          sequence: 3,
        },
      ]) {
        const { sequence, ...rowValues } = values
        metadata.sequence = sequence
        Object.assign(row, rowValues)
        yield row
      }
    }

    const write = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "snapshot",
    })
    await write.writeRows(reusedOrderRows())
    await write.commit()

    const persisted = await collectRows(storage.readRows({ datasetId: ordersDataset.id }))
    expect(persisted).toEqual([
      {
        orderId: "ord_1",
        customerName: "Ada",
        orderCount: "1",
        metadata: { source: "erp", sequence: 1 },
      },
      {
        orderId: "ord_2",
        customerName: "Grace",
        orderCount: "2",
        metadata: { source: "erp", sequence: 2 },
      },
      {
        orderId: "ord_3",
        customerName: "Katherine",
        orderCount: "3",
        metadata: { source: "erp", sequence: 3 },
      },
    ])
  })

  test("evolves a dataset by appending a nullable column and writes new-format rows", async () => {
    const initialDataset = defineDataset("raw.erp.schema_evolution", {
      schema: [col("invoiceId", "string"), col("total", "int64")],
    })
    const evolvedDataset = defineDataset("raw.erp.schema_evolution", {
      schema: [
        col("currency", "string", { nullable: true }),
        col("invoiceId", "string"),
        col("total", "int64"),
      ],
    })
    const storedEvolvedDataset = defineDataset("raw.erp.schema_evolution", {
      schema: [
        col("invoiceId", "string"),
        col("total", "int64"),
        col("currency", "string", { nullable: true }),
      ],
    })

    await storage.createDataset(initialDataset)

    const initialWrite = await storage.beginWrite({
      dataset: initialDataset,
      mode: "snapshot",
    })
    await initialWrite.writeRows([{ invoiceId: "inv_1", total: 100 }])
    const initialVersion = await initialWrite.commit()

    await expect(storage.createDataset(evolvedDataset)).resolves.toEqual(storedEvolvedDataset)
    await expect(storage.getDataset(initialDataset.id)).resolves.toEqual(storedEvolvedDataset)
    const schemaVersion = await storage.getLatestVersion(initialDataset.id)
    const historicalVersion = await storage.getVersion(initialDataset.id, initialVersion.versionId)

    expect(historicalVersion?.schema).toEqual(initialDataset.schema)
    expect(schemaVersion).toMatchObject({
      mode: "schema",
      parentVersionId: initialVersion.versionId,
      rowCount: 1,
      schema: storedEvolvedDataset.schema,
    })

    const versionsAfterSchemaEvolution = await storage.listVersions(initialDataset.id)
    expect(versionsAfterSchemaEvolution).toHaveLength(2)
    expect(versionsAfterSchemaEvolution[0]).toMatchObject({
      versionId: schemaVersion?.versionId,
      mode: "schema",
      parentVersionId: initialVersion.versionId,
      rowCount: 1,
      schema: storedEvolvedDataset.schema,
    })
    expect(versionsAfterSchemaEvolution[1]).toMatchObject({
      versionId: initialVersion.versionId,
      rowCount: 1,
      schema: initialDataset.schema,
    })

    const evolvedWrite = await storage.beginWrite({
      dataset: evolvedDataset,
      mode: "append",
    })

    await evolvedWrite.writeRows([{ invoiceId: "inv_2", total: 200, currency: "EUR" }])
    const evolvedVersion = await evolvedWrite.commit()

    expect(evolvedVersion.parentVersionId).toBe(schemaVersion?.versionId)
    expect(evolvedVersion.schema).toEqual(storedEvolvedDataset.schema)
    await expect(storage.getLatestVersion(initialDataset.id)).resolves.toMatchObject({
      versionId: evolvedVersion.versionId,
      rowCount: 2,
    })
    await expect(collectRows(storage.readRows({ datasetId: initialDataset.id }))).resolves.toEqual([
      { invoiceId: "inv_1", total: "100", currency: null },
      { invoiceId: "inv_2", total: "200", currency: "EUR" },
    ])
    await expect(
      collectRows(
        storage.readRows({ datasetId: initialDataset.id, versionId: initialVersion.versionId })
      )
    ).resolves.toEqual([{ invoiceId: "inv_1", total: "100" }])
    await expect(
      collectRows(
        storage.readRows({
          datasetId: initialDataset.id,
          versionId: initialVersion.versionId,
          columns: ["currency"],
        })
      )
    ).rejects.toThrow("does not have column 'currency' at the requested version")
  })

  test("pins latest reads to the resolved version before selecting rows", async () => {
    const snapshotWrite = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "snapshot",
    })
    await snapshotWrite.writeRows([{ orderId: "ord_1", customerName: "Ada", orderCount: 1 }])
    const version1 = await snapshotWrite.commit()

    const appendWrite = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "append",
    })
    await appendWrite.writeRows([{ orderId: "ord_2", customerName: "Grace", orderCount: 2 }])
    await appendWrite.commit()

    const snapshotReader = (storage as unknown as DuckLakeStorageInternals).snapshotReader
    const getLatestVersionForDefinition =
      snapshotReader.getLatestVersionForDefinition.bind(snapshotReader)
    snapshotReader.getLatestVersionForDefinition = async () => version1

    try {
      await expect(collectRows(storage.readRows({ datasetId: ordersDataset.id }))).resolves.toEqual(
        [{ orderId: "ord_1", customerName: "Ada", orderCount: "1", metadata: null }]
      )
    } finally {
      snapshotReader.getLatestVersionForDefinition = getLatestVersionForDefinition
    }
  })

  test("rejects rows that do not match the dataset schema", async () => {
    const write = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "snapshot",
    })

    await expect(write.writeRows([{ orderId: "ord_1" }])).rejects.toThrow("missing required column")
    await expect(
      write.writeRows([
        {
          orderId: "ord_1",
          customerName: "Ada",
          orderCount: 1,
          unexpected: true,
        } as never,
      ])
    ).rejects.toThrow("unknown column")

    await write.abort()
    await expect(write.writeRows([])).rejects.toThrow("already closed")
  })

  test("abort closes the session without committing rows", async () => {
    const write = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "snapshot",
    })

    await write.writeRows([{ orderId: "ord_1", customerName: "Ada", orderCount: 1 }])
    await write.abort()
    await write.abort()

    expect(await storage.getLatestVersion("raw.erp.orders")).toBeNull()
    await expect(collectRows(storage.readRows({ datasetId: "raw.erp.orders" }))).rejects.toThrow(
      "No committed version found"
    )
  })

  test("commit closes the session and leaves abort idempotent", async () => {
    const write = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "snapshot",
    })

    await write.writeRows([{ orderId: "ord_1", customerName: "Ada", orderCount: 1 }])
    await write.commit()
    await write.abort()

    await expect(write.writeRows([])).rejects.toThrow("already closed")
  })

  test("commits a snapshot replacement to empty rows", async () => {
    const seed = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "snapshot",
    })
    await seed.writeRows([{ orderId: "ord_1", customerName: "Ada", orderCount: 1 }])
    const previous = await seed.commit()

    const replacement = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "snapshot",
    })
    const version = await replacement.commit()

    expect(version.versionId).not.toBe(previous.versionId)
    expect(version.mode).toBe("snapshot")
    expect(version.rowCount).toBe(0)
    expect(await storage.getLatestVersion(ordersDataset.id)).toMatchObject({
      versionId: version.versionId,
      mode: "snapshot",
      rowCount: 0,
    })
    await expect(collectRows(storage.readRows({ datasetId: ordersDataset.id }))).resolves.toEqual(
      []
    )
  })

  test("returns the current latest version for a no-op empty append", async () => {
    const seed = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "snapshot",
    })
    await seed.writeRows([{ orderId: "ord_1", customerName: "Ada", orderCount: 1 }])
    const previous = await seed.commit()

    const append = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "append",
    })
    const result = await append.commit()

    expect(result.versionId).toBe(previous.versionId)
    expect(result.rowCount).toBe(1)
    expect(
      (await storage.listVersions(ordersDataset.id)).map((version) => version.versionId)
    ).toEqual([previous.versionId])
    await expect(collectRows(storage.readRows({ datasetId: ordersDataset.id }))).resolves.toEqual([
      { orderId: "ord_1", customerName: "Ada", orderCount: "1", metadata: null },
    ])
  })

  test("throws a clear no-op error when an empty first snapshot changes nothing", async () => {
    const write = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "snapshot",
    })

    await expect(write.commit()).rejects.toThrow(
      `No DuckLake changes were committed for dataset '${ordersDataset.id}', and no previous version exists.`
    )
    expect(await storage.getLatestVersion(ordersDataset.id)).toBeNull()
    expect(await storage.listVersions(ordersDataset.id)).toEqual([])
  })

  test("throws a clear no-op error when an empty first append changes nothing", async () => {
    const write = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "append",
    })

    await expect(write.commit()).rejects.toThrow(
      `No DuckLake changes were committed for dataset '${ordersDataset.id}', and no previous version exists.`
    )
    expect(await storage.getLatestVersion(ordersDataset.id)).toBeNull()
    expect(await storage.listVersions(ordersDataset.id)).toEqual([])
  })
})
