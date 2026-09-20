import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { col, type DatasetRow, defineDataset } from "@sixb/core"
import { SQL } from "bun"
import { DuckLakeStorage, type DuckLakeStorageOptions } from "../../src"

// Isolate the driver's resource lifecycle from GC and query timings in preceding tests.
// With node-api 1.5.2-r.2, reserving only three pool slots can starve the immediate append below.
const options = JSON.parse(process.argv[2]!) as DuckLakeStorageOptions
const concurrency = Number(process.argv[3])
const root = await mkdtemp(join(tmpdir(), "sixb-reader-pg-budget-"))
const lake = new DuckLakeStorage({ ...options, dataPath: join(root, "data") })
const dataset = defineDataset("reader.budget", {
  schema: [col("id", "string"), col("value", "int64")],
})
const readers: AsyncIterator<DatasetRow>[] = []
try {
  await lake.createDataset(dataset)
  const write = await lake.beginWrite({ dataset, mode: "snapshot" })
  await write.writeRows(Array.from({ length: 20_003 }, (_, i) => ({ id: String(i), value: i })))
  const version = await write.commit()
  for (let i = 0; i < concurrency; i++) {
    readers.push(
      lake.readRows({ datasetId: dataset.id, versionId: version.versionId })[Symbol.asyncIterator]()
    )
  }
  const first = await Promise.all(readers.map((reader) => reader.next()))
  if (options.postgresPool?.maxConnections === 4 && options.catalog.type === "postgres") {
    const catalog = options.catalog
    const url = new URL(`postgres://${catalog.host}:${catalog.port ?? 5432}/${catalog.database}`)
    url.username = catalog.user ?? "postgres"
    url.password = catalog.password ?? ""
    const admin = new SQL({ url: url.toString(), max: 1 })
    try {
      // Assert the actual resource boundary too: GC/timing can hide a timeout, but a paused
      // native reader still retains a PostgreSQL transaction in this version of the driver.
      const [row] = await admin`SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE application_name = ${catalog.applicationName} AND state = 'idle in transaction'`
      if (Number(row?.count) !== 0) throw new Error("A small pool retained a streaming transaction")
    } finally {
      await admin.close()
    }
  }
  const append = await lake.beginWrite({ dataset, mode: "append" })
  await append.writeRows([{ id: "new", value: 42 }])
  await append.commit()
  for (const [index, reader] of readers.entries()) {
    const ids = new Set([first[index]!.value!.id])
    let count = 1
    for (let row = await reader.next(); !row.done; row = await reader.next()) {
      ids.add(row.value.id)
      count++
    }
    if (count !== 20_003 || ids.size !== count || ids.has("new"))
      throw new Error("Reader lost its snapshot")
  }
  let latestCount = 0
  for await (const _row of lake.readRows({ datasetId: dataset.id })) latestCount++
  if (latestCount !== 20_004) throw new Error("Concurrent append was not visible")
} finally {
  await Promise.allSettled(readers.map((reader) => reader.return?.()))
  await lake.close()
  await rm(root, { recursive: true, force: true })
}
