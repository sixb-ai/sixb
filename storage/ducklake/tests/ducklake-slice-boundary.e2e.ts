import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { watch } from "node:fs"
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

let rootDir: string
let production: DuckLakeStorage

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-slice-boundary-"))
  await mkdir(join(rootDir, "production"))
  production = createLocalDuckLakeStorage(join(rootDir, "production"))
})

afterEach(async () => {
  await production.close()
  await rm(rootDir, { recursive: true, force: true })
})

describe("a slice's boundary", () => {
  // Red check: in catalog-slice.ts `liveFiles`, name no copy (`copy = undefined`).
  test("no file it serves holds a row its version deleted, or a value it replaced", async () => {
    await write(
      people,
      Array.from({ length: 3_000 }, (_, index) => person(index, 1_000))
    )
    await merge(people, [
      ...Array.from({ length: 400 }, (_, index) => change.delete({ id: `p-${index * 7}` })),
      change.upsert({ ...person(1, 1_000), salary: 2_000 }),
    ])
    await merge(people, [change.delete({ id: "p-2" })])
    const { versions, slicePath, files } = await slice([people.id])
    const version = versions[0] as DatasetVersionRef

    const served: Record<string, unknown>[] = []
    for (const path of files) {
      served.push(...(await rawRows(path)))
    }
    const ids = new Set(served.map((row) => row.id))
    const rows = await collectRows(production.readRows(version))

    expect(ids.has("p-0")).toBe(false)
    expect(ids.has("p-7")).toBe(false)
    expect(ids.has("p-2")).toBe(false)
    expect(served.some((row) => row.id === "p-1" && row.salary === 1_000)).toBe(false)
    // Every row is served once, in a file or inlined in the slice.
    expect(served.length).toBeLessThanOrEqual(rows.length)

    const branch = openBranch(slicePath, await serve(files))
    try {
      expect(await sorted(branch.readRows({ datasetId: people.id }))).toEqual(await sorted(rows))
    } finally {
      await branch.close()
    }
  })

  // Red check: make `sliceCommitInfo` return the stored metadata as it is.
  test("its catalog names only its datasets, and commits as their reader sees them", async () => {
    await write(hidden, [{ id: "h-1", secret: "classified" }])
    await write(people, [person(1, 1_000), person(2, 1_000)])
    const hiddenVersion = await production.getLatestVersion(hidden.id)
    const peopleVersion = await production.getLatestVersion(people.id)
    if (!hiddenVersion || !peopleVersion) throw new Error("Missing versions")
    await production.createDataset(report)
    const session = await production.beginWrite({
      dataset: report,
      mode: "snapshot",
      producer: { kind: "pipeline", id: "payroll-report", runId: "run_private_42", stepId: "join" },
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

    const { slicePath } = await slice([people.id, report.id], { kind: "pipeline" })

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
          (await query("SELECT table_name FROM duckdb_tables() WHERE database_name = 'slice'")).map(
            ({ table_name }) => query(`SELECT * FROM slice."${table_name}"`)
          )
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
  })

  // Red check: in DuckLakeForks.writeSlice, cut on `withAttachedRuntime` instead.
  test("production keeps reading while a slice is cut", async () => {
    await write(
      people,
      Array.from({ length: 600_000 }, (_, index) => person(index, index))
    )
    await merge(people, [change.delete({ id: "p-3" })])
    await write(hidden, [{ id: "h-1", secret: "classified" }])
    const copies = join(rootDir, "production", "data-branch-copies")
    await mkdir(copies, { recursive: true })

    // The cut is under way once its first copy is being written.
    const copying = new Promise<void>((resolve) => {
      const watcher = watch(copies, () => {
        watcher.close()
        resolve()
      })
    })
    const order: string[] = []
    const cut = slice([people.id]).then(() => order.push("cut"))
    await copying
    await collectRows(production.readRows({ datasetId: hidden.id })).then(() => order.push("read"))
    await cut

    expect(order).toEqual(["read", "cut"])
  })

  // Red check: in DuckLakeForks.releaseFiles, delete every copy whatever the live slices read.
  test("its copies stay while a live slice reads them, and go once none does", async () => {
    await write(
      people,
      Array.from({ length: 2_000 }, (_, index) => person(index, index))
    )
    await merge(people, [change.delete({ id: "p-3" })])
    const { files } = await slice([people.id])
    const [copy] = [...files].filter((path) => path.startsWith("sixb-branch-copies/"))

    expect(copy).toBeDefined()
    const [health] = await production.maintenance.describeStorage([people.id])
    expect(health?.branchCopyBytes).toBe((await production.forks.openFile(`${copy}`))?.sizeBytes)

    expect(await production.forks.releaseFiles({ liveSlices: [[...files]] })).toBe(0)
    expect(await production.forks.releaseFiles({ liveSlices: [] })).toBe(0)

    // A copy younger than an hour may belong to a cut whose token is not stored yet.
    setSystemTime(new Date(Date.now() + 2 * 60 * 60_000))
    try {
      expect(await production.forks.releaseFiles({ liveSlices: [[...files]] })).toBe(0)
      expect(await production.forks.openFile(`${copy}`)).not.toBeNull()
      expect(await production.forks.releaseFiles({ liveSlices: [] })).toBe(1)
      expect(await production.forks.openFile(`${copy}`)).toBeNull()
    } finally {
      setSystemTime()
    }
  })

  // Red check: in catalog-slice.ts `liveFiles`, copy no file for its `partial_max`: the cut then
  // refuses, its rows not the version's. Drop the row-count check too, and the merged file is
  // served whole, rows written after the version included (DuckLake still filters them on read).
  test("a file compaction merged is served as a copy of the version's rows alone", async () => {
    await production.createDataset(people)
    await append(people, 0, 100)
    const point = await production.forks.currentPoint()
    const at = await production.forks.versionsAt({ point, datasetIds: [people.id] })
    const version = { datasetId: people.id, versionId: `${at.get(people.id)?.versionId}` }
    const expected = await sorted(production.readRows(version))
    await append(people, 100, 200)
    await append(people, 200, 300)
    await maintainElsewhere("CALL ducklake_merge_adjacent_files('other')")
    await reopenProduction()

    const slicePath = join(rootDir, "merged.ducklake")
    const files = await production.forks.writeSlice({
      point,
      versions: [version],
      path: slicePath,
      record: async () => undefined,
    })
    const served: Record<string, unknown>[] = []
    for (const path of files) served.push(...(await rawRows(path)))
    const ids = expected.map((line) => JSON.parse(line).id)
    expect(served.map((row) => row.id).sort()).toEqual(ids.sort())

    const branch = openBranch(slicePath, await serve(files))
    try {
      expect(await sorted(branch.readRows({ datasetId: people.id }))).toEqual(expected)
    } finally {
      await branch.close()
    }
  })

  // Red check: in DuckLakeMaintenance.deleteScheduledFiles, skip `holdFiles`: the files the slice
  // lists go once compaction replaced them, and the branch can no longer read its version.
  test("production's retention keeps the files a live slice lists after compaction replaced them", async () => {
    await production.createDataset(people)
    for (const start of [0, 100, 200]) await append(people, start, start + 100)
    const { versions, slicePath, files } = await slice([people.id])
    const expected = await sorted(production.readRows(versions[0] as DatasetVersionRef))
    await maintainElsewhere("CALL ducklake_merge_adjacent_files('other')")
    await reopenProduction()

    setSystemTime(new Date(Date.now() + 2 * 60 * 60_000))
    try {
      await production.maintenance.applyRetention({
        keepVersionsForMs: 60 * 60_000,
        deleteFilesAfterMs: 60 * 60_000,
        holdFiles: [...files],
      })
    } finally {
      setSystemTime()
    }

    for (const path of files) expect(await production.forks.openFile(path)).not.toBeNull()
    const branch = openBranch(slicePath, await serve(files))
    try {
      expect(await sorted(branch.readRows({ datasetId: people.id }))).toEqual(expected)
    } finally {
      await branch.close()
    }
  })

  test("partition values of any text reach their file", async () => {
    await write(stores, [
      { id: "s-1", city: "São Paulo / Centro 50%" },
      { id: "s-2", city: "Zürich?#" },
    ])
    const { versions, slicePath, files } = await slice([stores.id])
    const branch = openBranch(slicePath, await serve(files))
    try {
      expect(await sorted(branch.readRows({ datasetId: stores.id }))).toEqual(
        await sorted(await collectRows(production.readRows(versions[0] as DatasetVersionRef)))
      )
    } finally {
      await branch.close()
    }
  })
})

function person(index: number, salary: number) {
  return { id: `p-${index}`, name: `Person ${index}`, salary }
}

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
    return (await connection.runAndReadAll(`SELECT * FROM '${local}'`)).getRowObjectsJS() as Record<
      string,
      unknown
    >[]
  } finally {
    connection.closeSync()
    instance.closeSync()
  }
}

function openBranch(slicePath: string, url: string): DuckLakeStorage {
  const directory = join(rootDir, `branch-${Math.random()}`)
  return new DuckLakeStorage({
    catalog: { type: "duckdb", path: slicePath },
    dataPath: join(directory, "data"),
    productionFiles: { url, token: () => "token", cacheDirectory: join(directory, "cache") },
  })
}

const servers: { stop(force: boolean): void }[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

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

async function sorted(rows: AsyncIterable<Record<string, unknown>> | Record<string, unknown>[]) {
  const lines: string[] = []
  for await (const row of rows as AsyncIterable<Record<string, unknown>>)
    lines.push(JSON.stringify(row))
  return lines.sort()
}
