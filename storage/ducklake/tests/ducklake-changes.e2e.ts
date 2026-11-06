import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { col, type DatasetRow, defineDataset } from "@sixb/core"
import type { DatasetChanges, DatasetWriteMode } from "@sixb/core/lake-storage"
import { runLakeChangesContractSuite } from "@sixb/core/testing"
import type { DuckLakeStorage } from "../src"
import type { DuckDbRuntime } from "../src/internal/duckdb-runtime"
import { createLocalDuckLakeStorage } from "./test-utils"

interface DuckLakeStorageInternals {
  readonly connections: {
    attachedRuntime(): Promise<DuckDbRuntime>
  }
}

const roots = new WeakMap<DuckLakeStorage, string>()
runLakeChangesContractSuite("DuckLakeStorage changes", {
  async createStorage() {
    const root = await mkdtemp(join(tmpdir(), "sixb-ducklake-changes-"))
    const storage = createLocalDuckLakeStorage(root)
    roots.set(storage, root)
    return storage
  },
  async teardown(storage) {
    await storage.close()
    await rm(roots.get(storage)!, { recursive: true, force: true })
  },
})

describe("DuckLakeStorage changes between versions of identical rows", () => {
  const dataset = defineDataset("delta.provenance", {
    schema: [col("id", "string"), col("value", "string")],
  })

  let rootDir: string
  let storage: DuckLakeStorage
  let inputs = 0

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-identical-changes-"))
    storage = createLocalDuckLakeStorage(rootDir)
    await storage.createDataset(dataset)
  })

  afterEach(async () => {
    await storage.close()
    await rm(rootDir, { recursive: true, force: true })
  })

  /** Each write names a new input version, so identical rows still create a version. */
  async function write(rows: readonly DatasetRow[], mode: DatasetWriteMode = "snapshot") {
    inputs += 1
    const session = await storage.beginWrite({
      dataset,
      mode,
      inputs: [{ datasetId: "upstream", versionId: `ducklake:${inputs}` }],
    })
    await session.writeRows(rows)
    const version = await session.commit()
    expect(version.outcome).toBe("created")
    return version.versionId
  }

  /** Records every statement that reads the dataset table at a version. */
  async function recordTableReads<T>(run: () => Promise<T>) {
    const internals = storage as unknown as DuckLakeStorageInternals
    const runtime = await internals.connections.attachedRuntime()
    const query = runtime.query.bind(runtime)
    const execute = runtime.run.bind(runtime)
    const reads: string[] = []
    const record = (sql: string) => {
      if (/\bAT\s*\(\s*VERSION\s*=>/i.test(sql)) reads.push(sql)
    }

    runtime.query = (async (sql, values) => {
      record(sql)
      return query(sql, values)
    }) satisfies DuckDbRuntime["query"]
    runtime.run = (async (sql, values) => {
      record(sql)
      return execute(sql, values)
    }) satisfies DuckDbRuntime["run"]

    try {
      return { result: await run(), reads }
    } finally {
      runtime.query = query
      runtime.run = execute
    }
  }

  function read(fromVersionId: string, toVersionId: string) {
    return storage.readChanges({
      datasetId: dataset.id,
      fromVersionId,
      toVersionId,
      keyColumns: ["id"],
      columns: ["id", "value"],
    })
  }

  async function collect(reader: DatasetChanges | null) {
    if (!reader) throw new Error("Expected a complete delta")
    const changes = []
    try {
      for await (const change of reader.changes) changes.push(change)
    } finally {
      await reader.close()
    }
    return { fromRowCount: reader.fromRowCount, toRowCount: reader.toRowCount, changes }
  }

  const rows = [
    { id: "A", value: "one" },
    { id: "B", value: "two" },
  ]

  // Red check: remove the `unchanged` branch of the change reader; the table is then read.
  test("reads no change without reading the table", async () => {
    const first = await write(rows)
    const provenanceOnly = await write(rows)
    const emptyAppend = await write([], "append")

    for (const [from, to] of [
      [first, emptyAppend],
      [provenanceOnly, provenanceOnly],
    ] as const) {
      const { result, reads } = await recordTableReads(async () => collect(await read(from, to)))
      expect(result).toEqual({ fromRowCount: 2, toRowCount: 2, changes: [] })
      expect(reads).toEqual([])
    }
  })

  test("compares the rows when a version in between changed them", async () => {
    const first = await write(rows)
    await write([rows[0]!, { id: "B", value: "new" }])
    const provenanceOnly = await write([rows[0]!, { id: "B", value: "new" }])

    const { result, reads } = await recordTableReads(async () =>
      collect(await read(first, provenanceOnly))
    )
    expect(result).toEqual({
      fromRowCount: 2,
      toRowCount: 2,
      changes: [{ before: { id: "B", value: "two" }, after: { id: "B", value: "new" } }],
    })
    expect(reads).not.toEqual([])
  })

  // Red check: drop the limit of the walk in `holdsRowsOf`; the long history is walked.
  // Its 34 commits take 3-5 s on a CI runner, past the default 5 s timeout, hence the bound.
  test("compares the rows rather than walk a long history", async () => {
    const first = await write(rows)
    let latest = first
    // One past the 32 versions the walk reads between the two.
    for (let version = 0; version < 33; version += 1) latest = await write(rows)

    const { result, reads } = await recordTableReads(async () => collect(await read(first, latest)))
    expect(result).toEqual({ fromRowCount: 2, toRowCount: 2, changes: [] })
    expect(reads).not.toEqual([])
  }, 30_000)
})
