import { describe, expect, setSystemTime, test } from "bun:test"
import { type FSWatcher, watch } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DuckDBInstance } from "@duckdb/node-api"
import { change, col, type DatasetDefinition, defineDataset } from "@sixb/core"
import type { DatasetVersionRef, LakeSliceVersion } from "@sixb/core/lake-storage"
import { DuckLakeStorage } from "../src"
import { collectRows, createLocalDuckLakeStorage } from "./test-utils"

// What leaves production: the slice's catalog and the files it serves. A branch holds the token,
// so it can read any of those files whole: none may hold a row its version no longer returns.

const people = defineDataset("boundary.people", {
  schema: [col("id", "string"), col("name", "string"), col("salary", "float64")],
  primaryKey: "id",
})
const hidden = defineDataset("boundary.hidden", {
  schema: [col("id", "string"), col("secret", "string")],
  primaryKey: "id",
})
const report = defineDataset("boundary.report", {
  schema: [col("name", "string"), col("salary", "float64"), col("secret", "string")],
})
const stores = defineDataset("boundary.stores", {
  schema: [col("id", "string"), col("city", "string")],
  partitionBy: ["city"],
})
const peopleWithTeam = defineDataset("boundary.people", {
  schema: [...people.schema.columns, col("team", "string", { nullable: true })],
  primaryKey: "id",
})
const customers = defineDataset("boundary.customers", {
  schema: [col("email", "string"), col("revision", "int64"), col("name", "string")],
  primaryKey: "email",
  sequenceBy: "revision",
})

/**
 * A test on a production lake of its own, closed once its body settles: a body that outlives its
 * timeout goes on with its own lake, and never reaches the next test's.
 */
function lakeTest(name: string, run: (lake: ProductionLake) => Promise<void>, timeoutMs?: number) {
  test(
    name,
    async () => {
      const lake = await productionLake()
      try {
        await run(lake)
      } finally {
        await lake.close()
      }
    },
    timeoutMs
  )
}

/** Bounds a test that writes enough rows for a cut to take a while on a slow runner. */
const SLOW_TEST_MS = 60_000

describe("a slice's boundary", () => {
  // Red check: in catalog-slice.ts `liveFiles`, name no copy (`copy = undefined`).
  lakeTest(
    "no file it serves holds a row its version deleted, or a value it replaced",
    async (lake) => {
      await lake.write(
        people,
        Array.from({ length: 3_000 }, (_, index) => person(index, 1_000))
      )
      await lake.merge(people, [
        ...Array.from({ length: 400 }, (_, index) => change.delete({ id: `p-${index * 7}` })),
        change.upsert({ ...person(1, 1_000), salary: 2_000 }),
      ])
      await lake.merge(people, [change.delete({ id: "p-2" })])
      const { versions, slicePath, files } = await lake.slice([people.id])
      const version = versions[0] as DatasetVersionRef

      const served: Record<string, unknown>[] = []
      for (const path of files) {
        served.push(...(await lake.rawRows(path)))
      }
      const ids = new Set(served.map((row) => row.id))
      const rows = await collectRows(lake.production.readRows(version))

      expect(ids.has("p-0")).toBe(false)
      expect(ids.has("p-7")).toBe(false)
      expect(ids.has("p-2")).toBe(false)
      expect(served.some((row) => row.id === "p-1" && row.salary === 1_000)).toBe(false)
      // Every row is served once, in a file or inlined in the slice.
      expect(served.length).toBeLessThanOrEqual(rows.length)

      const branch = lake.openBranch(slicePath, await lake.serve(files))
      try {
        expect(await sorted(branch.readRows({ datasetId: people.id }))).toEqual(await sorted(rows))
      } finally {
        await branch.close()
      }
    }
  )

  // Red check: make `sliceCommitInfo` return the stored metadata as it is.
  lakeTest(
    "its catalog names only its datasets, and commits as their reader sees them",
    async (lake) => {
      await lake.write(hidden, [{ id: "h-1", secret: "classified" }])
      await lake.write(people, [person(1, 1_000), person(2, 1_000)])
      const hiddenVersion = await lake.production.getLatestVersion(hidden.id)
      const peopleVersion = await lake.production.getLatestVersion(people.id)
      if (!hiddenVersion || !peopleVersion) throw new Error("Missing versions")
      await lake.production.createDataset(report)
      const session = await lake.production.beginWrite({
        dataset: report,
        mode: "snapshot",
        producer: {
          kind: "pipeline",
          id: "payroll-report",
          runId: "run_private_42",
          stepId: "join",
        },
        inputs: [
          { datasetId: people.id, versionId: peopleVersion.versionId },
          { datasetId: hidden.id, versionId: hiddenVersion.versionId },
        ],
        lineage: {
          rows: [{ datasetId: hidden.id, column: "id" }],
          columns: {
            name: [{ datasetId: people.id, column: "name" }],
            salary: [{ datasetId: people.id, column: "salary" }],
            secret: [{ datasetId: hidden.id, column: "secret" }],
          },
        },
      })
      await session.writeRows([{ name: "Ada", salary: 1_000, secret: "redacted" }])
      await session.commit({ commitMessage: "payroll-report run_private_42 step join" })

      const { slicePath } = await lake.slice([people.id, report.id], { kind: "pipeline" })

      const instance = await DuckDBInstance.create(":memory:")
      const connection = await instance.connect()
      try {
        await connection.run(`ATTACH '${slicePath}' AS slice (READ_ONLY)`)
        const query = async (sql: string) =>
          (await connection.runAndReadAll(sql)).getRowObjectsJson() as Record<string, unknown>[]

        const tables = await query("SELECT table_name FROM slice.ducklake_table ORDER BY 1")
        const commits = JSON.stringify(await query("SELECT * FROM slice.ducklake_snapshot_changes"))
        const everything = JSON.stringify(
          await Promise.all(
            (
              await query("SELECT table_name FROM duckdb_tables() WHERE database_name = 'slice'")
            ).map(({ table_name }) => query(`SELECT * FROM slice."${table_name}"`))
          )
        )

        expect(tables.map((row) => row.table_name)).toEqual([
          "sixb__ds__boundary__people",
          "sixb__ds__boundary__report",
        ])
        expect(commits).toContain('\\"kind\\":\\"pipeline\\"')
        expect(commits).not.toContain("payroll-report")
        expect(commits).not.toContain("run_private_42")
        expect(everything).not.toContain(hidden.id)
        expect(everything).not.toContain("classified")
        expect(await query("SELECT * FROM slice.ducklake_delete_file")).toEqual([])
        expect(await query("SELECT * FROM slice.ducklake_table_column_stats")).toEqual([])
      } finally {
        connection.closeSync()
        instance.closeSync()
      }
    }
  )

  // Red check: in DuckLakeForks.writeSlice, cut on `withAttachedRuntime` instead.
  lakeTest(
    "production keeps reading while a slice is cut",
    async (lake) => {
      await lake.write(
        people,
        Array.from({ length: 600_000 }, (_, index) => person(index, index))
      )
      await lake.merge(people, [change.delete({ id: "p-3" })])
      await lake.write(hidden, [{ id: "h-1", secret: "classified" }])
      const copies = join(lake.rootDir, "production", "data-branch-copies")
      await mkdir(copies, { recursive: true })

      // The cut is under way once its first copy is being written. A cut that writes none ends
      // first, and fails the order below rather than waiting.
      let watcher: FSWatcher | undefined
      const copyWritten = new Promise<void>((resolve) => {
        watcher = watch(copies, () => resolve())
      })
      const order: string[] = []
      const cut = lake.slice([people.id]).then(() => order.push("cut"))
      try {
        await Promise.race([copyWritten, cut])
        await collectRows(lake.production.readRows({ datasetId: hidden.id })).then(() =>
          order.push("read")
        )
        await cut
      } finally {
        watcher?.close()
      }

      expect(order).toEqual(["read", "cut"])
    },
    SLOW_TEST_MS
  )

  // Red check: in DuckLakeForks.releaseFiles, delete every copy whatever the live slices read.
  lakeTest("its copies stay while a live slice reads them, and go once none does", async (lake) => {
    await lake.write(
      people,
      Array.from({ length: 2_000 }, (_, index) => person(index, index))
    )
    await lake.merge(people, [change.delete({ id: "p-3" })])
    const { files } = await lake.slice([people.id])
    const [copy] = [...files].filter((path) => path.startsWith("sixb-branch-copies/"))

    expect(copy).toBeDefined()
    const [health] = await lake.production.maintenance.describeStorage([people.id])
    expect(health?.branchCopyBytes).toBe(
      (await lake.production.forks.openFile(`${copy}`))?.sizeBytes
    )

    expect(await lake.production.forks.releaseFiles({ liveSlices: [[...files]] })).toBe(0)
    expect(await lake.production.forks.releaseFiles({ liveSlices: [] })).toBe(0)

    // A copy younger than an hour may belong to a cut whose token is not stored yet.
    setSystemTime(new Date(Date.now() + 2 * 60 * 60_000))
    try {
      expect(await lake.production.forks.releaseFiles({ liveSlices: [[...files]] })).toBe(0)
      expect(await lake.production.forks.openFile(`${copy}`)).not.toBeNull()
      expect(await lake.production.forks.releaseFiles({ liveSlices: [] })).toBe(1)
      expect(await lake.production.forks.openFile(`${copy}`)).toBeNull()
    } finally {
      setSystemTime()
    }
  })

  // Red check: in slice-copies.ts `writeCopy`, drop the `touchCopy` of a copy it reuses: the
  // second slice's copy keeps its first write's time, and the retention below deletes it.
  lakeTest("a copy a new cut reuses stays as long as a new copy would", async (lake) => {
    await lake.write(
      people,
      Array.from({ length: 2_000 }, (_, index) => person(index, index))
    )
    await lake.merge(people, [change.delete({ id: "p-3" })])
    const first = await lake.slice([people.id])
    const [copy] = [...first.files].filter((path) => path.startsWith("sixb-branch-copies/"))
    expect(copy).toBeDefined()

    // Two hours later another branch is cut at the same version: it reuses the copy.
    setSystemTime(new Date(Date.now() + 2 * 60 * 60_000))
    try {
      const second = await lake.slice([people.id])
      expect(second.files.has(`${copy}`)).toBe(true)

      // Retention that read the live slices before the second cut recorded its slice.
      expect(await lake.production.forks.releaseFiles({ liveSlices: [] })).toBe(0)
      expect(await lake.production.forks.openFile(`${copy}`)).not.toBeNull()
    } finally {
      setSystemTime()
    }
  })

  // Red check: in catalog-slice.ts `liveFiles`, copy no file for its `partial_max`: the cut then
  // refuses, its rows not the version's. Drop the row-count check too, and the merged file is
  // served whole, rows written after the version included (DuckLake still filters them on read).
  lakeTest(
    "a file compaction merged is served as a copy of the version's rows alone",
    async (lake) => {
      await lake.production.createDataset(people)
      await lake.append(people, 0, 100)
      const point = await lake.production.forks.currentPoint()
      const at = await lake.production.forks.versionsAt({ point, datasetIds: [people.id] })
      const version = { datasetId: people.id, versionId: `${at.get(people.id)?.versionId}` }
      const expected = await sorted(lake.production.readRows(version))
      await lake.append(people, 100, 200)
      await lake.append(people, 200, 300)
      await lake.maintainElsewhere("CALL ducklake_merge_adjacent_files('other')")
      await lake.reopenProduction()

      const slicePath = join(lake.rootDir, "merged.ducklake")
      const files = await lake.production.forks.writeSlice({
        point,
        versions: [version],
        path: slicePath,
        record: async () => undefined,
      })
      const served: Record<string, unknown>[] = []
      for (const path of files) served.push(...(await lake.rawRows(path)))
      const ids = expected.map((line) => JSON.parse(line).id)
      expect(served.map((row) => row.id).sort()).toEqual(ids.sort())

      const branch = lake.openBranch(slicePath, await lake.serve(files))
      try {
        expect(await sorted(branch.readRows({ datasetId: people.id }))).toEqual(expected)
      } finally {
        await branch.close()
      }
    }
  )

  // Red check: in DuckLakeMaintenance.deleteScheduledFiles, skip `holdFiles`: the files the slice
  // lists go once compaction replaced them, and the branch can no longer read its version.
  lakeTest(
    "production's retention keeps the files a live slice lists after compaction replaced them",
    async (lake) => {
      await lake.production.createDataset(people)
      for (const start of [0, 100, 200]) await lake.append(people, start, start + 100)
      const { versions, slicePath, files } = await lake.slice([people.id])
      const expected = await sorted(lake.production.readRows(versions[0] as DatasetVersionRef))
      await lake.maintainElsewhere("CALL ducklake_merge_adjacent_files('other')")
      await lake.reopenProduction()

      setSystemTime(new Date(Date.now() + 2 * 60 * 60_000))
      try {
        await lake.production.maintenance.applyRetention({
          keepVersionsForMs: 60 * 60_000,
          deleteFilesAfterMs: 60 * 60_000,
          holdFiles: [...files],
        })
      } finally {
        setSystemTime()
      }

      for (const path of files) expect(await lake.production.forks.openFile(path)).not.toBeNull()
      const branch = lake.openBranch(slicePath, await lake.serve(files))
      try {
        expect(await sorted(branch.readRows({ datasetId: people.id }))).toEqual(expected)
      } finally {
        await branch.close()
      }
    }
  )

  // Red check: in DuckLakeForks.sliceTables, drop `withoutTombstones` from the source-ordering
  // table: the slice's catalog and the files it serves name every erased customer.
  lakeTest(
    "its source ordering holds no key the version deleted, and still orders a branch's merges",
    async (lake) => {
      await lake.production.createDataset(customers)
      await lake.merge(
        customers,
        Array.from({ length: 40 }, (_, index) => change.upsert(customer(index, 1)))
      )

      // Twelve erasures in one merge write their tombstones to a file; the last one is inlined.
      const erased = [...Array.from({ length: 12 }, (_, index) => email(index)), email(39)]
      await lake.merge(
        customers,
        erased.slice(0, 12).map((key) => change.delete({ email: key }, { sequence: 2 }))
      )
      await lake.merge(customers, [change.delete({ email: email(39) }, { sequence: 2 })])

      const { versions, slicePath, files } = await lake.slice([customers.id])
      const leaving = [await lake.catalogText(slicePath)]
      for (const path of files) leaving.push(await lake.rawText(path))

      for (const key of erased) expect(leaving.join("\n")).not.toContain(key)
      expect(leaving.join("\n")).toContain(email(20))

      // The branch's merges are ordered against the keys it holds: an older revision is ignored.
      const branch = lake.openBranch(slicePath, await lake.serve(files))
      try {
        const merge = await branch.beginMerge({ dataset: customers })
        await merge.writeChanges([
          change.upsert({ ...customer(20, 0), name: "Stale" }),
          change.upsert({ ...customer(21, 3), name: "Renamed" }),
        ])
        await merge.commit()

        const rows = await collectRows(branch.readRows({ datasetId: customers.id }))
        expect(rows).toHaveLength(40 - erased.length)
        expect(rows.find((row) => row.email === email(20))?.name).toBe("Customer 20")
        expect(rows.find((row) => row.email === email(21))?.name).toBe("Renamed")
      } finally {
        await branch.close()
      }

      const production = await collectRows(
        lake.production.readRows(versions[0] as DatasetVersionRef)
      )
      expect(production).toHaveLength(40 - erased.length)
    },
    SLOW_TEST_MS
  )

  // Red check: in catalog-slice.ts `copyInlinedRows`, copy an inlined table that holds no live
  // row too: the cut binds the added column at a version before it, and refuses.
  lakeTest("a slice pinned before a column was added holds its version's rows", async (lake) => {
    await lake.write(people, [person(1, 1_000), person(2, 2_000)])
    const pinned = await lake.production.getLatestVersion(people.id)
    if (!pinned) throw new Error("Missing version")

    // A deploy adds a column, and nothing is written since: the version a projection applied
    // stays the one before it.
    await lake.production.createDataset(peopleWithTeam)
    const point = await lake.production.forks.currentPoint()
    const version = { datasetId: people.id, versionId: pinned.versionId }

    const slicePath = join(lake.rootDir, "pinned.ducklake")
    const files = await lake.production.forks.writeSlice({
      point,
      versions: [version],
      path: slicePath,
      record: async () => undefined,
    })

    const branch = lake.openBranch(slicePath, await lake.serve(files))
    try {
      expect(await sorted(branch.readRows(version))).toEqual(
        await sorted(lake.production.readRows(version))
      )
    } finally {
      await branch.close()
    }
  })

  lakeTest("partition values of any text reach their file", async (lake) => {
    await lake.write(stores, [
      { id: "s-1", city: "São Paulo / Centro 50%" },
      { id: "s-2", city: "Zürich?#" },
    ])
    const { versions, slicePath, files } = await lake.slice([stores.id])
    const branch = lake.openBranch(slicePath, await lake.serve(files))
    try {
      expect(await sorted(branch.readRows({ datasetId: stores.id }))).toEqual(
        await sorted(await collectRows(lake.production.readRows(versions[0] as DatasetVersionRef)))
      )
    } finally {
      await branch.close()
    }
  })
})

function person(index: number, salary: number) {
  return { id: `p-${index}`, name: `Person ${index}`, salary }
}

function email(index: number) {
  return `customer-${index}@example.com`
}

function customer(index: number, revision: number) {
  return { email: email(index), revision, name: `Customer ${index}` }
}

/** A production lake for one test, with what the test does to it. */
async function productionLake() {
  const rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-slice-boundary-"))
  await mkdir(join(rootDir, "production"))
  let production = createLocalDuckLakeStorage(join(rootDir, "production"))
  const servers: { stop(force: boolean): void }[] = []

  async function write(dataset: DatasetDefinition, rows: Record<string, unknown>[]) {
    await production.createDataset(dataset)
    const session = await production.beginWrite({ dataset, mode: "snapshot" })
    await session.writeRows(rows)
    await session.commit()
  }

  /** Rows `start` to `end`, appended as one file. */
  async function append(dataset: DatasetDefinition, start: number, end: number) {
    const session = await production.beginWrite({ dataset, mode: "append" })
    await session.writeRows(
      Array.from({ length: end - start }, (_, index) => person(start + index, 1))
    )
    await session.commit()
  }

  /** Another process's maintenance of production's catalog, such as compaction in a worker. */
  async function maintainElsewhere(sql: string) {
    await production.close()
    const instance = await DuckDBInstance.create(":memory:")
    const connection = await instance.connect()
    try {
      const directory = join(rootDir, "production")
      await connection.run("LOAD ducklake")
      await connection.run(
        `ATTACH 'ducklake:${join(directory, "metadata.ducklake")}' AS other (DATA_PATH '${join(directory, "data")}/')`
      )
      await connection.run(sql)
    } finally {
      connection.closeSync()
      instance.closeSync()
    }
  }

  async function reopenProduction() {
    production = createLocalDuckLakeStorage(join(rootDir, "production"))
  }

  async function merge(
    dataset: DatasetDefinition,
    changes: Parameters<Awaited<ReturnType<DuckLakeStorage["beginMerge"]>>["writeChanges"]>[0]
  ) {
    const session = await production.beginMerge({ dataset })
    await session.writeChanges(changes)
    await session.commit()
  }

  async function slice(datasetIds: string[], producer?: LakeSliceVersion["producer"]) {
    const point = await production.forks.currentPoint()
    const at = await production.forks.versionsAt({ point, datasetIds })
    const versions = datasetIds.map((datasetId) => ({
      datasetId,
      versionId: `${at.get(datasetId)?.versionId}`,
      ...(producer ? { producer } : {}),
    }))
    const slicePath = join(rootDir, `slice-${datasetIds.length}-${Math.random()}.ducklake`)
    const files = await production.forks.writeSlice({
      point,
      versions,
      path: slicePath,
      record: async () => undefined,
    })
    return {
      versions: versions.map(({ datasetId, versionId }) => ({ datasetId, versionId })),
      slicePath,
      files,
    }
  }

  /** A served file, read whole as a branch holding the token could. */
  async function rawRows(path: string): Promise<Record<string, unknown>[]> {
    const file = await production.forks.openFile(path)
    if (!file) throw new Error(`No file at '${path}'`)
    const local = join(rootDir, `raw-${Math.random()}.parquet`)
    await Bun.write(local, new Response(file.read()))

    const instance = await DuckDBInstance.create(":memory:")
    const connection = await instance.connect()
    try {
      // Delete files hold positions, not rows; every other file holds rows.
      const columns = (await connection.runAndReadAll(`DESCRIBE SELECT * FROM '${local}'`))
        .getRowObjectsJson()
        .map((row) => String(row.column_name))
      if (!columns.includes("id")) return []
      return (
        await connection.runAndReadAll(`SELECT * FROM '${local}'`)
      ).getRowObjectsJS() as Record<string, unknown>[]
    } finally {
      connection.closeSync()
      instance.closeSync()
    }
  }

  /** Every row of a served file, as text. */
  async function rawText(path: string): Promise<string> {
    const file = await production.forks.openFile(path)
    if (!file) throw new Error(`No file at '${path}'`)
    const local = join(rootDir, `raw-${Math.random()}.parquet`)
    await Bun.write(local, new Response(file.read()))

    return withDuckDb(async (query) => JSON.stringify(await query(`SELECT * FROM '${local}'`)))
  }

  /** Every row of every table of a slice's catalog, as text. */
  async function catalogText(slicePath: string): Promise<string> {
    return withDuckDb(async (query) => {
      await query(`ATTACH '${slicePath}' AS slice (READ_ONLY)`)
      const tables = await query(
        "SELECT table_name FROM duckdb_tables() WHERE database_name = 'slice'"
      )
      const rows = []
      for (const { table_name } of tables)
        rows.push(await query(`SELECT * FROM slice."${table_name}"`))
      return JSON.stringify(rows)
    })
  }

  function openBranch(slicePath: string, url: string): DuckLakeStorage {
    const directory = join(rootDir, `branch-${Math.random()}`)
    return new DuckLakeStorage({
      catalog: { type: "duckdb", path: slicePath },
      dataPath: join(directory, "data"),
      productionFiles: { url, token: () => "token", cacheDirectory: join(directory, "cache") },
    })
  }

  /** Production's file route, reduced to the slice's files. */
  async function serve(listed: ReadonlySet<string>): Promise<string> {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
          .slice(1)
          .split("/")
          .map(decodeURIComponent)
          .join("/")
        const file = listed.has(path) ? await production.forks.openFile(path) : null
        if (!file) return new Response(null, { status: 404 })
        if (request.method === "HEAD") {
          return new Response(null, { headers: { "content-length": String(file.sizeBytes) } })
        }
        const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get("range") ?? "") ?? []
        return new Response(file.read({ start: Number(start), endInclusive: Number(end) }), {
          status: 206,
        })
      },
    })
    servers.push(server)
    return `http://127.0.0.1:${server.port}/`
  }

  const lake = {
    rootDir,
    get production() {
      return production
    },
    write,
    append,
    maintainElsewhere,
    reopenProduction,
    merge,
    slice,
    rawRows,
    rawText,
    catalogText,
    openBranch,
    serve,
    async close() {
      for (const server of servers.splice(0)) server.stop(true)
      await production.close()
      await rm(rootDir, { recursive: true, force: true })
    },
  }
  return lake
}

type ProductionLake = Awaited<ReturnType<typeof productionLake>>

/** Runs `run` on a DuckDB of its own, in memory. */
async function withDuckDb<T>(
  run: (query: (sql: string) => Promise<Record<string, unknown>[]>) => Promise<T>
): Promise<T> {
  const instance = await DuckDBInstance.create(":memory:")
  const connection = await instance.connect()
  try {
    return await run(
      async (sql) =>
        (await connection.runAndReadAll(sql)).getRowObjectsJson() as Record<string, unknown>[]
    )
  } finally {
    connection.closeSync()
    instance.closeSync()
  }
}

async function sorted(rows: AsyncIterable<Record<string, unknown>> | Record<string, unknown>[]) {
  const lines: string[] = []
  for await (const row of rows as AsyncIterable<Record<string, unknown>>)
    lines.push(JSON.stringify(row))
  return lines.sort()
}
