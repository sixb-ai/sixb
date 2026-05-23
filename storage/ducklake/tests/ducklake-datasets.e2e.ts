import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { col, defineDataset, LakeStorageError } from "@sixb/core"
import type { DuckLakeStorage } from "../src"
import {
  createDuckDbRuntime,
  type DuckDbExclusiveRuntime,
  type DuckDbRuntime,
  setupDuckLake,
} from "../src/internal/duckdb-runtime"
import { encodeDatasetTableName } from "../src/internal/names"
import { createLocalDuckLakeStorage, localDuckLakeOptions } from "./test-utils"

describe("DuckLakeStorage dataset metadata", () => {
  let rootDir: string
  let storage: DuckLakeStorage

  const ordersDataset = defineDataset("raw.erp.orders", {
    schema: [
      col("orderId", "string"),
      col("customerId", "string", { nullable: true }),
      col("isOpen", "boolean"),
      col("count", "int64"),
      col("score", "float64"),
      col("amount", "decimal"),
      col("orderDate", "date"),
      col("createdAt", "timestamp"),
      col("metadata", "json", { nullable: true }),
      col("attachment", "fileRef", { nullable: true }),
    ],
    partitionBy: ["customerId", "orderDate"],
    description: "Raw ERP orders",
  })

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-datasets-"))
    storage = createLocalDuckLakeStorage(rootDir)
  })

  afterEach(async () => {
    await storage.close()
    await rm(rootDir, { recursive: true, force: true })
  })

  test("creates, gets, and lists schema-backed datasets", async () => {
    const created = await storage.createDataset(ordersDataset)
    const repeated = await storage.createDataset(ordersDataset)

    expect(created).toEqual(ordersDataset)
    expect(repeated).toEqual(ordersDataset)
    expect(await storage.getDataset("raw.erp.orders")).toEqual(ordersDataset)
    expect(await storage.getDataset("missing.dataset")).toBeNull()
    expect(await storage.listDatasets()).toEqual([ordersDataset])
  })

  test("preserves compatible definitions and rejects incompatible definitions", async () => {
    await storage.createDataset(ordersDataset)

    await expect(storage.createDataset(ordersDataset)).resolves.toEqual(ordersDataset)

    const rejected = storage.createDataset(
      defineDataset("raw.erp.orders", {
        schema: [col("orderId", "int64")],
      })
    )

    await expect(rejected).rejects.toBeInstanceOf(LakeStorageError)
    await expect(rejected).rejects.toThrow("changing column 'orderId' type")
  })

  test("treats same-column declaration reorders as a provider no-op", async () => {
    const initialDataset = defineDataset("raw.erp.reordered_schema", {
      schema: [col("orderId", "string"), col("orderDate", "date"), col("amount", "int64")],
    })
    const reorderedDataset = defineDataset("raw.erp.reordered_schema", {
      schema: [col("amount", "int64"), col("orderDate", "date"), col("orderId", "string")],
    })

    await storage.createDataset(initialDataset)
    await expect(storage.listVersions(initialDataset.id)).resolves.toEqual([])

    await expect(storage.createDataset(reorderedDataset)).resolves.toEqual(initialDataset)
    await expect(storage.getDataset(initialDataset.id)).resolves.toEqual(initialDataset)
    await expect(storage.listVersions(initialDataset.id)).resolves.toEqual([])
  })

  test("persists compatible metadata added after initial dataset creation", async () => {
    const minimalDataset = defineDataset("raw.erp.customers", {
      schema: [col("customerId", "string")],
    })
    const documentedDataset = defineDataset("raw.erp.customers", {
      schema: [col("customerId", "string")],
      description: "Raw ERP customers",
    })

    await storage.createDataset(minimalDataset)
    await expect(storage.createDataset(documentedDataset)).resolves.toEqual(documentedDataset)

    expect(await storage.getDataset(documentedDataset.id)).toEqual(documentedDataset)
    expect(await storage.listDatasets()).toEqual([documentedDataset])
  })

  test("persists compatible partition metadata added after initial dataset creation", async () => {
    const minimalDataset = defineDataset("raw.erp.partitioned.orders", {
      schema: [col("orderId", "string"), col("orderDate", "date")],
    })
    const partitionedDataset = defineDataset("raw.erp.partitioned.orders", {
      schema: [col("orderId", "string"), col("orderDate", "date")],
      partitionBy: ["orderDate"],
    })

    await storage.createDataset(minimalDataset)
    await expect(storage.createDataset(partitionedDataset)).resolves.toEqual(partitionedDataset)

    expect(await storage.getDataset(partitionedDataset.id)).toEqual(partitionedDataset)
    expect(await storage.listDatasets()).toEqual([partitionedDataset])
  })

  test("rejects unsupported schema evolution cases in V1", async () => {
    const initialDataset = defineDataset("raw.erp.schema_policy", {
      schema: [
        col("orderId", "string"),
        col("amount", "int64"),
        col("notes", "string", { nullable: true }),
      ],
    })

    await storage.createDataset(initialDataset)

    await expect(
      storage.createDataset(
        defineDataset("raw.erp.schema_policy", {
          schema: [
            col("orderId", "string"),
            col("amount", "int64"),
            col("notes", "string", { nullable: true }),
            col("currency", "string"),
          ],
        })
      )
    ).rejects.toThrow("adding required column 'currency' is not supported")

    await expect(
      storage.createDataset(
        defineDataset("raw.erp.schema_policy", {
          schema: [col("orderId", "string"), col("amount", "int64")],
        })
      )
    ).rejects.toThrow("dropping column 'notes' is not supported")

    await expect(
      storage.createDataset(
        defineDataset("raw.erp.schema_policy", {
          schema: [
            col("orderId", "string"),
            col("amount", "decimal"),
            col("notes", "string", { nullable: true }),
          ],
        })
      )
    ).rejects.toThrow("changing column 'amount' type from 'int64' to 'decimal' is not supported")

    await expect(
      storage.createDataset(
        defineDataset("raw.erp.schema_policy", {
          schema: [col("orderId", "string"), col("amount", "int64"), col("notes", "string")],
        })
      )
    ).rejects.toThrow("changing column 'notes' nullability is not supported")

    await expect(storage.getDataset(initialDataset.id)).resolves.toEqual(initialDataset)
  })

  test("applies schema evolution and partition changes in one definition update", async () => {
    const initialDataset = defineDataset("raw.erp.schema_partition_policy", {
      schema: [col("orderId", "string"), col("orderDate", "date")],
    })
    const evolvedPartitionedDataset = defineDataset("raw.erp.schema_partition_policy", {
      schema: [
        col("orderId", "string"),
        col("orderDate", "date"),
        col("currency", "string", { nullable: true }),
      ],
      partitionBy: ["orderDate"],
    })

    await storage.createDataset(initialDataset)

    await expect(storage.createDataset(evolvedPartitionedDataset)).resolves.toEqual(
      evolvedPartitionedDataset
    )
    await expect(storage.getDataset(initialDataset.id)).resolves.toEqual(evolvedPartitionedDataset)

    const versions = await storage.listVersions(initialDataset.id)
    expect(versions).toHaveLength(1)
    expect(versions[0]).toMatchObject({
      datasetId: initialDataset.id,
      mode: "schema",
      schema: evolvedPartitionedDataset.schema,
      rowCount: 0,
    })
  })

  test("keeps schema evolution transaction exclusive from concurrent commit blocks", async () => {
    const initialSchemaDataset = defineDataset("raw.erp.concurrent_schema", {
      schema: [col("invoiceId", "string")],
    })
    const evolvedSchemaDataset = defineDataset("raw.erp.concurrent_schema", {
      schema: [col("invoiceId", "string"), col("currency", "string", { nullable: true })],
    })

    await storage.createDataset(initialSchemaDataset)

    const runtime = await runtimeForStorage(storage)
    const pause = pauseAfterNextBeginTransaction(runtime)

    const schemaEvolution = storage.createDataset(evolvedSchemaDataset)
    await withTimeout(pause.paused, "schema evolution did not begin a transaction")

    const concurrentCommitBlock = runtime.withExclusive(async (runtime) => {
      await runtime.run("BEGIN TRANSACTION")
      await runtime.run("COMMIT")
    })
    expect(await settlesWithin(concurrentCommitBlock, 25)).toBe(false)

    pause.resume()

    await expect(schemaEvolution).resolves.toEqual(evolvedSchemaDataset)
    await expect(concurrentCommitBlock).resolves.toBeUndefined()
  })

  test("does not detach the local catalog during a whole dataset list read", async () => {
    await storage.createDataset(ordersDataset)

    const runtime = await runtimeForStorage(storage)
    const pause = pauseAfterNextQuery(runtime, (sql) => sql.includes("duckdb_tables()"))

    const listing = storage.listDatasets()
    await withTimeout(pause.paused, "listDatasets did not reach its first metadata query")

    const beginWrite = storage.beginWrite({
      dataset: ordersDataset,
      mode: "append",
    })
    expect(await settlesWithin(beginWrite, 25)).toBe(false)

    pause.resume()

    await expect(listing).resolves.toEqual([ordersDataset])
    const write = await beginWrite
    await write.abort()
  })

  test("listDatasets filters non-dataset provider tables", async () => {
    const runtime = await createDuckDbRuntime()

    try {
      await setupDuckLake(runtime, localDuckLakeOptions(rootDir))

      await runtime.run(
        `CREATE TABLE sixb_lake.main.${encodeDatasetTableName("raw.erp.orders")} ("orderId" VARCHAR NOT NULL)`
      )
      await runtime.run("CREATE TABLE sixb_lake.main.sixb__sys__state (id VARCHAR)")
      await runtime.run('CREATE TABLE sixb_lake.main."sixb__ds__bad-" (id VARCHAR)')
    } finally {
      await runtime.close()
    }

    expect(await storage.listDatasets()).toEqual([
      defineDataset("raw.erp.orders", {
        schema: [col("orderId", "string")],
      }),
    ])
  })

  test("fails with an actionable error when existing metadata uses unsupported column types", async () => {
    const runtime = await createDuckDbRuntime()

    try {
      await setupDuckLake(runtime, localDuckLakeOptions(rootDir))

      await runtime.run(
        `CREATE TABLE sixb_lake.main.${encodeDatasetTableName("raw.erp.unsupported")} (id INTEGER)`
      )
    } finally {
      await runtime.close()
    }

    await expect(storage.getDataset("raw.erp.unsupported")).rejects.toThrow(
      "cannot be mapped to a Sixb dataset column type"
    )
  })

  test("rejects non-identity DuckLake partition transforms in V1", async () => {
    const runtime = await createDuckDbRuntime()

    try {
      await setupDuckLake(runtime, localDuckLakeOptions(rootDir))

      const tableName = encodeDatasetTableName("raw.erp.partitioned")
      await runtime.run(`CREATE TABLE sixb_lake.main.${tableName} ("orderDate" DATE NOT NULL)`)
      await runtime.run(
        `ALTER TABLE sixb_lake.main.${tableName} SET PARTITIONED BY (year("orderDate"))`
      )
    } finally {
      await runtime.close()
    }

    await expect(storage.getDataset("raw.erp.partitioned")).rejects.toThrow(
      "unsupported DuckLake partition transform"
    )
  })
})

async function runtimeForStorage(storage: DuckLakeStorage): Promise<DuckDbRuntime> {
  return (
    storage as unknown as { readonly connections: { attachedRuntime(): Promise<DuckDbRuntime> } }
  ).connections.attachedRuntime()
}

function pauseAfterNextBeginTransaction(runtime: DuckDbRuntime): {
  readonly paused: Promise<void>
  resume(): void
} {
  const paused = createDeferred<void>()
  const resumed = createDeferred<void>()
  const originalRun = runtime.run.bind(runtime)
  const originalWithExclusive = runtime.withExclusive.bind(runtime)
  let didPause = false

  async function pauseIfNeeded(sql: string): Promise<void> {
    if (didPause || sql !== "BEGIN TRANSACTION") {
      return
    }

    didPause = true
    paused.resolve()
    await resumed.promise
  }

  runtime.run = async (sql, values) => {
    await originalRun(sql, values)
    await pauseIfNeeded(sql)
  }

  runtime.withExclusive = (useRuntime) =>
    originalWithExclusive((exclusiveRuntime) =>
      useRuntime(wrapExclusiveRuntime(exclusiveRuntime, pauseIfNeeded))
    )

  return {
    paused: paused.promise,
    resume: () => resumed.resolve(),
  }
}

function pauseAfterNextQuery(
  runtime: DuckDbRuntime,
  matches: (sql: string) => boolean
): {
  readonly paused: Promise<void>
  resume(): void
} {
  const paused = createDeferred<void>()
  const resumed = createDeferred<void>()
  const originalQuery = runtime.query.bind(runtime)
  let didPause = false

  runtime.query = async (sql, values) => {
    const rows = await originalQuery(sql, values)
    if (!didPause && matches(sql)) {
      didPause = true
      paused.resolve()
      await resumed.promise
    }

    return rows
  }

  return {
    paused: paused.promise,
    resume: () => resumed.resolve(),
  }
}

function wrapExclusiveRuntime(
  runtime: DuckDbExclusiveRuntime,
  afterRun: (sql: string) => Promise<void>
): DuckDbExclusiveRuntime {
  return {
    run: async (sql, values) => {
      await runtime.run(sql, values)
      await afterRun(sql)
    },
    runStatements: (statements) => runtime.runStatements(statements),
    query: (sql, values) => runtime.query(sql, values),
    withAppender: (tableName, useAppender) => runtime.withAppender(tableName, useAppender),
  }
}

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timeout: Timer | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), 1_000)
      }),
    ])
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout)
    }
  }
}

async function settlesWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timeout: Timer | undefined
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true
      ),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), milliseconds)
      }),
    ])
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout)
    }
  }
}

function createDeferred<T = void>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T | PromiseLike<T>) => void
} {
  let resolve: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })

  return {
    promise,
    resolve: resolve!,
  }
}
