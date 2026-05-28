import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { col, defineDataset } from "@pario/core"
import { type DuckDbSecretOptions, DuckLakeStorage, type DuckLakeStorageOptions } from "../src"
import { DuckLakeConnectionManager } from "../src/internal/ducklake-connection-manager"
import { collectRows } from "./test-utils"

describe("DuckLakeStorage remote catalogs", () => {
  test("uses a PostgreSQL catalog with a local data path", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pario-ducklake-pg-local-"))
    const dataset = defineDataset(`raw.pg.local.${randomId()}`, {
      schema: [col("orderId", "string")],
    })
    const storage = new DuckLakeStorage({
      catalog: postgresCatalog(),
      dataPath: join(rootDir, "data"),
    })

    try {
      await storage.createDataset(dataset)
      const write = await storage.beginWrite({ dataset, mode: "snapshot" })
      await write.writeRows([{ orderId: "ord_1" }])
      await write.commit()

      const append = await storage.beginWrite({ dataset, mode: "append" })
      await append.writeRows([{ orderId: "ord_2" }])
      await append.commit()

      expect(await collectRows(storage.readRows({ datasetId: dataset.id }))).toEqual([
        { orderId: "ord_1" },
        { orderId: "ord_2" },
      ])
    } finally {
      await storage.close()
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  test("uses a PostgreSQL catalog with an S3-compatible data path", async () => {
    const dataset = defineDataset(`raw.pg.s3.${randomId()}`, {
      schema: [col("orderId", "string")],
    })
    const storage = new DuckLakeStorage({
      catalog: postgresCatalog(),
      dataPath: `s3://${s3Bucket()}/lake/${randomId()}`,
      secrets: [minioSecret()],
    })

    try {
      await storage.createDataset(dataset)
      const write = await storage.beginWrite({ dataset, mode: "snapshot" })
      await write.writeRows([{ orderId: "ord_1" }])
      await write.commit()

      expect(await collectRows(storage.readRows({ datasetId: dataset.id }))).toEqual([
        { orderId: "ord_1" },
      ])
    } finally {
      await storage.close()
    }
  })

  test("does not exhaust the PostgreSQL catalog pool across repeated metadata reads", async () => {
    const dataset = defineDataset(`raw.pg.metadata.${randomId()}`, {
      schema: [col("orderId", "string")],
    })
    const storage = new DuckLakeStorage({
      catalog: postgresCatalog(),
      dataPath: `s3://${s3Bucket()}/lake/${randomId()}`,
      secrets: [minioSecret()],
    })

    try {
      await storage.createDataset(dataset)
      const write = await storage.beginWrite({ dataset, mode: "snapshot" })
      await write.writeRows([{ orderId: "ord_1" }])
      const version = await write.commit()

      for (let index = 0; index < 20; index += 1) {
        await expect(storage.getDataset(dataset.id)).resolves.toMatchObject({ id: dataset.id })
        await expect(storage.getLatestVersion(dataset.id)).resolves.toMatchObject({
          versionId: version.versionId,
        })
      }
    } finally {
      await storage.close()
    }
  }, 60_000)

  test("allows two provider instances to commit to one PostgreSQL catalog", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pario-ducklake-pg-shared-"))
    const dataset = defineDataset(`raw.pg.shared.${randomId()}`, {
      schema: [col("orderId", "string")],
    })
    const options: DuckLakeStorageOptions = {
      catalog: postgresCatalog(),
      dataPath: join(rootDir, "data"),
    }
    const first = new DuckLakeStorage(options)
    const second = new DuckLakeStorage(options)

    try {
      await first.createDataset(dataset)

      const firstWrite = await first.beginWrite({ dataset, mode: "snapshot" })
      await firstWrite.writeRows([{ orderId: "ord_1" }])
      const firstVersion = await firstWrite.commit()

      const secondWrite = await second.beginWrite({ dataset, mode: "append" })
      await secondWrite.writeRows([{ orderId: "ord_2" }])
      await secondWrite.commit({ expectedLatestVersionId: firstVersion.versionId })

      expect(await collectRows(first.readRows({ datasetId: dataset.id }))).toEqual([
        { orderId: "ord_1" },
        { orderId: "ord_2" },
      ])
    } finally {
      await first.close()
      await second.close()
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  test("reuses clean PostgreSQL write leases after committed reads", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pario-ducklake-pg-lease-"))
    const connections = new DuckLakeConnectionManager({
      catalog: postgresCatalog(),
      dataPath: join(rootDir, "data"),
    })

    try {
      const lease = await connections.acquireWriteLease()
      const writeRuntime = lease.runtime
      const readRuntime = await lease.committedReadRuntime({
        kind: "committed",
        guarded: false,
        reusable: true,
      })

      expect(readRuntime).not.toBe(writeRuntime)
      await lease.release({ kind: "committed", guarded: false, reusable: true })

      const nextLease = await connections.acquireWriteLease()
      expect(nextLease.runtime).toBe(writeRuntime)
      await expect(nextLease.runtime.query("SELECT 1 AS value")).resolves.toEqual([{ value: 1 }])
      await nextLease.release({ kind: "aborted" })
    } finally {
      await connections.close()
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})

function postgresCatalog(): DuckLakeStorageOptions["catalog"] {
  return {
    type: "postgres",
    host: process.env.PARIO_DUCKLAKE_POSTGRES_HOST ?? "127.0.0.1",
    port: Number(process.env.PARIO_DUCKLAKE_POSTGRES_PORT ?? "54331"),
    database: process.env.PARIO_DUCKLAKE_POSTGRES_DATABASE ?? "postgres",
    user: process.env.PARIO_DUCKLAKE_POSTGRES_USER ?? "postgres",
    password: process.env.PARIO_DUCKLAKE_POSTGRES_PASSWORD ?? "test",
    metadataSchema: `pario_${randomId()}`,
  }
}

function minioSecret(): DuckDbSecretOptions {
  return {
    type: "s3",
    keyId: process.env.PARIO_DUCKLAKE_S3_KEY_ID ?? "pario",
    secret: process.env.PARIO_DUCKLAKE_S3_SECRET ?? "pario-secret",
    region: "us-east-1",
    endpoint: process.env.PARIO_DUCKLAKE_S3_ENDPOINT ?? "127.0.0.1:19000",
    urlStyle: "path",
    useSsl: false,
    scope: `s3://${s3Bucket()}`,
  }
}

function s3Bucket(): string {
  return process.env.PARIO_DUCKLAKE_S3_BUCKET ?? "pario-ducklake"
}

function randomId(): string {
  return randomUUID().replaceAll("-", "_")
}
