import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { change, col, type DatasetDefinition, type DatasetRow, defineDataset } from "@sixb/core"
import type { DatasetChanges, DatasetRowChange, DatasetWriteMode } from "@sixb/core/lake-storage"
import { runLakeChangesContractSuite } from "@sixb/core/testing"
import type { DuckLakeStorage } from "../src"
import type { DuckDbExclusiveRuntime, DuckDbRuntime } from "../src/internal/duckdb-runtime"
import { encodeDatasetTableName } from "../src/internal/names"
import { quoteIdentifier, quoteSqlString } from "../src/internal/sql"
import { parseVersionId } from "../src/internal/versions"
import { collectRows, createLocalDuckLakeStorage } from "./test-utils"

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

  // Red check: remove the `holdsRowsOf` branch of the change reader; the table is then read.
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

  // Red check: in `readChangeRange`, keep maintenance commits among the versions; the compaction
  // then reads as a change of rows, and the table is read.
  test("reads no change across a compaction", async () => {
    const first = await write(rows)
    await compact(storage, dataset.id)
    const provenanceOnly = await write(rows)

    const { result, reads } = await recordTableReads(async () =>
      collect(await read(first, provenanceOnly))
    )
    expect(result).toEqual({ fromRowCount: 2, toRowCount: 2, changes: [] })
    expect(reads).toEqual([])
  })

  // Red check: in the change reader's `holdsRowsOf`, ignore whether the range is complete. The
  // expired version's change then goes unread.
  test("compares the rows when a version in between was expired", async () => {
    const first = await write(rows)
    const changed = await write([rows[0]!, { id: "B", value: "new" }])
    const provenanceOnly = await write([rows[0]!, { id: "B", value: "new" }])
    await internals(storage).connections.withExclusiveAttached(async (runtime) => {
      await runtime.run(
        `CALL ducklake_expire_snapshots('sixb_lake', versions => [${parseVersionId(changed)}])`
      )
    })

    expect(await collect(await read(first, provenanceOnly))).toEqual({
      fromRowCount: 2,
      toRowCount: 2,
      changes: [{ before: { id: "B", value: "two" }, after: { id: "B", value: "new" } }],
    })
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

interface ChangeReaderInternals {
  readonly changes: {
    compareFeed(...args: unknown[]): Promise<boolean>
  }
  readonly compaction: {
    commitMaintenance(
      dataset: DatasetDefinition,
      calls: readonly string[],
      movesUnreported: boolean
    ): Promise<boolean>
  }
  readonly connections: {
    attachedRuntime(): Promise<DuckDbRuntime>
    withExclusiveAttached<T>(run: (runtime: DuckDbExclusiveRuntime) => Promise<T>): Promise<T>
  }
}

describe("DuckLakeStorage changes from the change feed", () => {
  let rootDir: string
  let storage: DuckLakeStorage

  // Both versions together hold just over FEED_MIN_ROWS rows.
  const accounts = defineDataset("crm.accounts", {
    schema: [col("id", "string"), col("name", "string"), col("score", "int64")],
    primaryKey: "id",
  })
  const seedRows = Array.from({ length: 50_100 }, (_, i) => ({
    id: `a${i}`,
    name: "seed",
    score: i,
  }))

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-feed-"))
    storage = createLocalDuckLakeStorage(rootDir)
    await storage.createDataset(accounts)
  })

  afterEach(async () => {
    await storage.close()
    await rm(rootDir, { recursive: true, force: true })
  })

  // Regression proof: in readChangeRange, look only for DuckLake's marks of maintenance. A flush of
  // deletes alone bears none: the range then reads as altered outside Sixb, and the read compares
  // in full.
  test("reads the feed across a compaction that flushed deletes alone", async () => {
    const first = (await snapshot(seedRows)).versionId

    const merge = await storage.beginMerge({ dataset: accounts })
    await merge.writeChanges([change.delete({ id: "a5" })])
    const deleted = (await merge.commit()).version!.versionId

    await internals(storage).compaction.commitMaintenance(
      accounts,
      [
        `CALL ducklake_flush_inlined_data('sixb_lake', table_name => ${quoteSqlString(encodeDatasetTableName(accounts.id))})`,
      ],
      true
    )

    const rows = edited(await currentRows(), { rename: ["a1"] })
    const last = (await snapshot(rows)).versionId

    const compareFeed = spyOn(internals(storage).changes, "compareFeed")
    for (const [from, to] of [
      [first, last],
      [deleted, last],
    ] as const) {
      expect(await changesBetween(from, to)).toEqual(await expectedChanges(from, to))
    }

    expect(compareFeed).toHaveBeenCalledTimes(2)
    expect(await compareFeed.mock.results.at(-1)?.value).toBe(true)
  }, 60_000)

  // Regression proof: in compareFeed, stop cancelling rows by row id. A key changed twice then
  // shows up as a change. Or in planFeedRead, read one range across the maintenance commit: it
  // then holds every row the compaction moved, and the read falls back to comparing in full.
  test("reads exactly what changed between any two versions, across merges and compaction", async () => {
    const versions: string[] = []
    let rows: readonly DatasetRow[] = seedRows
    versions.push((await snapshot(rows)).versionId)

    rows = edited(rows, { rename: ["a1", "a2", "a3"], remove: ["a5", "a6"], add: ["n1", "n2"] })
    versions.push((await snapshot(rows)).versionId)

    const merge = await storage.beginMerge({ dataset: accounts })
    await merge.writeChanges([
      change.upsert({ id: "a1", name: "merged", score: 1 }),
      change.upsert({ id: "n3", name: "merged", score: 3 }),
      change.delete({ id: "a7" }),
    ])
    const merged = await merge.commit()
    versions.push(merged.version!.versionId)
    rows = await currentRows()

    const append = await storage.beginWrite({ dataset: accounts, mode: "append" })
    await append.writeRows([{ id: "n4", name: "appended", score: 4 }])
    const appended = (await append.commit()).versionId
    versions.push(appended)
    rows = await currentRows()

    // The same rows from new inputs: a version that changes none.
    const provenance = await storage.beginWrite({
      dataset: accounts,
      mode: "snapshot",
      inputs: [{ datasetId: "crm.sources", versionId: "ducklake:1" }],
    })
    await provenance.writeRows(rows)
    const provenanceOnly = (await provenance.commit()).versionId
    versions.push(provenanceOnly)

    await compact(storage, accounts.id)

    // a1 changes again, and n1, added in between, goes.
    rows = edited(rows, { rename: ["a1", "a4"], remove: ["n1"], add: ["n5"] })
    versions.push((await snapshot(rows)).versionId)
    expect(new Set(versions).size).toBe(versions.length)

    const compareFeed = spyOn(internals(storage).changes, "compareFeed")
    for (const [index, from] of versions.entries()) {
      for (const to of versions.slice(index + 1)) {
        const calls = compareFeed.mock.calls.length
        expect(await changesBetween(from, to)).toEqual(await expectedChanges(from, to))

        // The version of new inputs holds its parent's rows: neither is read.
        if (from === appended && to === provenanceOnly) {
          expect(compareFeed.mock.calls.length).toBe(calls)
          continue
        }

        // Read from the feed, not compared in full after it.
        expect(compareFeed.mock.calls.length).toBe(calls + 1)
        expect(await compareFeed.mock.results.at(-1)?.value).toBe(true)
      }
    }
  }, 60_000)

  // Regression proof: in planFeedRead, drop the check that a version recorded rowChanges, or the
  // one that every snapshot in between is still there. The replacement, or the expired version,
  // then goes unread, and the delta misses its changes.
  test("compares the versions instead when the feed cannot tell", async () => {
    const compareFeed = spyOn(internals(storage).changes, "compareFeed")
    const first = (await snapshot(seedRows)).versionId

    // A full replacement in between: every row changes.
    const replaced = seedRows.map((row) => ({ ...row, score: row.score + 1 }))
    const replacement = (await snapshot(replaced)).versionId
    const restored = (await snapshot(seedRows)).versionId
    expect(await changesBetween(first, restored)).toEqual([])
    expect(await changesBetween(first, replacement)).toEqual(
      await expectedChanges(first, replacement)
    )

    // A version written outside Sixb, with no record of what it changed.
    await internals(storage).connections.withExclusiveAttached(async (runtime) => {
      await runtime.run(
        `UPDATE sixb_lake.main.${quoteIdentifier(encodeDatasetTableName(accounts.id))} SET name = 'outside' WHERE id = 'a9'`
      )
    })
    const outside = (await storage.getLatestVersion(accounts.id))!.versionId
    const after = (await snapshot(edited(await currentRows(), { rename: ["a10"] }))).versionId
    expect(await changesBetween(restored, after)).toEqual(await expectedChanges(restored, after))
    expect(outside).not.toBe(restored)

    // A version in between expired by retention.
    const middle = (await snapshot(edited(await currentRows(), { rename: ["a11"] }))).versionId
    const last = (await snapshot(edited(await currentRows(), { rename: ["a12"] }))).versionId
    const expected = await expectedChanges(after, last)
    await internals(storage).connections.withExclusiveAttached(async (runtime) => {
      await runtime.run(
        `CALL ducklake_expire_snapshots('sixb_lake', versions => [${parseVersionId(middle)}])`
      )
    })
    expect(await changesBetween(after, last)).toEqual(expected)

    // Identities other than the primary key are compared too.
    const byName = await storage.readChanges({
      datasetId: accounts.id,
      fromVersionId: first,
      toVersionId: last,
      keyColumns: ["id", "name"],
      columns: ["id", "name"],
    })
    await byName?.close()

    expect(compareFeed).not.toHaveBeenCalled()
  }, 60_000)

  // Regression proof: in compareVersions, count distinct keys whatever the versions validated.
  // The comparison, which a full replacement in between sends there, then runs the distinct count
  // on both versions.
  test("compares two large versions on their validated primary key without counting distinct keys", async () => {
    const first = (await snapshot(seedRows)).versionId
    await snapshot(seedRows.map((row) => ({ ...row, name: "replaced" })))
    const last = (await snapshot(edited(seedRows, { rename: ["a1"] }))).versionId

    const runtime = await internals(storage).connections.attachedRuntime()
    const query = spyOn(runtime, "query")
    try {
      expect(await changesBetween(first, last)).toEqual(await expectedChanges(first, last))
      expect(query.mock.calls.some(([sql]) => /count\(DISTINCT/i.test(String(sql)))).toBe(false)
    } finally {
      query.mockRestore()
    }

    // A blank key still refuses the change read, as for any identity.
    const blank = (await snapshot([...seedRows, { id: " ", name: "blank", score: 0 }])).versionId
    expect(
      await storage.readChanges({
        datasetId: accounts.id,
        fromVersionId: last,
        toVersionId: blank,
        keyColumns: ["id"],
        columns: ["id", "name"],
      })
    ).toBeNull()
  }, 60_000)

  // Regression proof: in readChangeRange, keep a snapshot that altered the table outside Sixb
  // out of the range's completeness. The feed then reads across the column dropped and added
  // again, and reports the before image of the rows it restored without their old note.
  test("compares the versions instead across a column another client dropped and added again", async () => {
    const notes = defineDataset("crm.notes", {
      schema: [col("id", "string"), col("note", "string", { nullable: true })],
      primaryKey: "id",
    })
    await storage.createDataset(notes)
    const rows = Array.from({ length: 50_100 }, (_, i) => ({
      id: `n${i}`,
      note: i < 3 ? `kept ${i}` : null,
    }))
    const write = async (next: readonly DatasetRow[]) => {
      const session = await storage.beginWrite({ dataset: notes, mode: "snapshot" })
      await session.writeRows(next)
      return (await session.commit()).versionId
    }

    const first = await write(rows)
    await internals(storage).connections.withExclusiveAttached(async (runtime) => {
      const table = `sixb_lake.main.${quoteIdentifier(encodeDatasetTableName(notes.id))}`
      await runtime.run(`ALTER TABLE ${table} DROP COLUMN note`)
      await runtime.run(`ALTER TABLE ${table} ADD COLUMN note VARCHAR`)
    })
    const last = await write(rows)

    const compareFeed = spyOn(internals(storage).changes, "compareFeed")
    const delta = await storage.readChanges({
      datasetId: notes.id,
      fromVersionId: first,
      toVersionId: last,
      keyColumns: ["id"],
      columns: ["id", "note"],
    })
    const changes: DatasetRowChange[] = []
    try {
      for await (const change of delta?.changes ?? []) changes.push(change)
    } finally {
      await delta?.close()
    }

    expect(compareFeed).not.toHaveBeenCalled()
    expect(changes).toEqual([])
  }, 60_000)

  async function snapshot(rows: readonly DatasetRow[]) {
    const write = await storage.beginWrite({ dataset: accounts, mode: "snapshot" })
    await write.writeRows(rows)
    return write.commit()
  }

  async function currentRows(versionId?: string) {
    const rows = await collectRows(storage.readRows({ datasetId: accounts.id, versionId }))
    return rows.map((row) => ({ ...row, score: Number(row.score) }))
  }

  async function changesBetween(fromVersionId: string, toVersionId: string) {
    const delta = await storage.readChanges({
      datasetId: accounts.id,
      fromVersionId,
      toVersionId,
      keyColumns: ["id"],
      columns: ["id", "name", "score"],
    })
    if (!delta) throw new Error("[Test] The change read fell back to a full read.")

    const changes: DatasetRowChange[] = []
    try {
      for await (const change of delta.changes) changes.push(change)
    } finally {
      await delta.close()
    }

    expect(delta.changeCount).toBe(changes.length)
    return sortChanges(changes)
  }

  /** The changes between two versions, from reading both in full. */
  async function expectedChanges(fromVersionId: string, toVersionId: string) {
    const read = async (versionId: string) =>
      new Map(
        (await collectRows(storage.readRows({ datasetId: accounts.id, versionId }))).map((row) => [
          String(row.id),
          row,
        ])
      )
    const before = await read(fromVersionId)
    const after = await read(toVersionId)

    const changes: DatasetRowChange[] = []
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      const left = before.get(id) ?? null
      const right = after.get(id) ?? null
      if (JSON.stringify(left) !== JSON.stringify(right)) {
        changes.push({ before: left, after: right })
      }
    }

    return sortChanges(changes)
  }
})

function internals(storage: DuckLakeStorage): ChangeReaderInternals {
  return storage as unknown as ChangeReaderInternals
}

async function compact(storage: DuckLakeStorage, datasetId: string) {
  const table = quoteSqlString(encodeDatasetTableName(datasetId))
  for (const calls of [
    [`CALL ducklake_flush_inlined_data('sixb_lake', table_name => ${table})`],
    [
      `CALL ducklake_rewrite_data_files('sixb_lake', ${table}, delete_threshold => 0)`,
      `CALL ducklake_merge_adjacent_files('sixb_lake', ${table})`,
    ],
  ]) {
    await internals(storage).connections.withExclusiveAttached(async (runtime) => {
      await runtime.run("BEGIN TRANSACTION")
      for (const call of calls) await runtime.run(call)
      await runtime.run("COMMIT")
    })
  }
}

function edited(
  rows: readonly DatasetRow[],
  edit: {
    readonly rename?: readonly string[]
    readonly remove?: readonly string[]
    readonly add?: readonly string[]
  }
): DatasetRow[] {
  const renamed = rows
    .filter((row) => !edit.remove?.includes(String(row.id)))
    .map((row) =>
      edit.rename?.includes(String(row.id)) ? { ...row, name: `${String(row.name)}+` } : row
    )
  return [...renamed, ...(edit.add ?? []).map((id) => ({ id, name: "added", score: 0 }))]
}

function sortChanges(changes: readonly DatasetRowChange[]): DatasetRowChange[] {
  const key = (change: DatasetRowChange) => String((change.after ?? change.before)?.id)
  return [...changes].sort((left, right) => key(left).localeCompare(key(right)))
}
