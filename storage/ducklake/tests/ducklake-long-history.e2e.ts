import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { col, type DatasetDefinition, defineDataset } from "@sixb/core"
import type { DuckLakeStorage } from "../src"
import type { DuckDbRuntime } from "../src/internal/duckdb-runtime"
import { encodeDatasetTableName } from "../src/internal/names"
import { duckLakeMetadataTableName, quoteSqlString } from "../src/internal/sql"
import { createLocalDuckLakeStorage, localDuckLakeOptions } from "./test-utils"

interface DuckLakeStorageInternals {
  readonly connections: {
    attachedRuntime(): Promise<DuckDbRuntime>
  }
}

// Production catalogs reach tens of thousands of snapshots because maintenance never expires
// them. Committing that many through DuckLake takes minutes, so the history is written straight
// into the catalog: each fake snapshot is a Sixb commit to the busy dataset.
const HISTORY_LENGTH = 30_000

const busy = defineDataset("history.busy", { schema: [col("id", "string")] })
const stale = Array.from({ length: 19 }, (_, index) =>
  defineDataset(`history.stale_${index}`, { schema: [col("id", "string")] })
)

describe("DuckLakeStorage with a long snapshot history", () => {
  let rootDir: string | undefined
  let storage: DuckLakeStorage | undefined

  afterEach(async () => {
    await storage?.close()
    if (rootDir) await rm(rootDir, { recursive: true, force: true })
  })

  // SQLite catalogs share these reads; writing the fake history through DuckDB's SQLite extension
  // alone takes over a minute. The PostgreSQL catalog runs the same check in the remote suite.
  for (const catalog of ["duckdb"] as const) {
    test(`${catalog}: reads stale datasets in a constant number of queries`, async () => {
      // Red check: restore the catalog-wide snapshot walk in querySnapshotCandidates. Each stale
      // read then pages through all 30k snapshots, about 235 queries instead of a handful.
      rootDir = await mkdtemp(join(tmpdir(), `sixb-ducklake-history-${catalog}-`))
      storage = createLocalDuckLakeStorage(rootDir, catalog)
      const lake = storage
      const [first, ...others] = stale
      if (!first) throw new Error("Missing stale dataset")
      const originals = new Map<string, Awaited<ReturnType<typeof commit>>>()
      for (const dataset of [busy, ...stale]) {
        await lake.createDataset(dataset)
        originals.set(dataset.id, await commit(lake, dataset, "original"))
      }
      const runtime = await (
        lake as unknown as DuckLakeStorageInternals
      ).connections.attachedRuntime()
      await appendBusyHistory(runtime, rootDir, catalog)
      const busyLatest = await commit(lake, busy, "after history")
      const cursor = (await lake.listLatestVersionsSince({ cursor: null }))?.cursor
      if (!cursor) throw new Error("Missing feed cursor")

      const query = spyOn(runtime, "query")
      try {
        const counted = async <T>(read: () => Promise<T>) => {
          query.mockClear()
          const result = await read()
          return { result, queries: query.mock.calls.length }
        }

        const latest = await counted(() => lake.getLatestVersion(first.id))
        expect(latest.result?.versionId).toBe(originals.get(first.id)?.versionId)
        expect(latest.queries).toBeLessThanOrEqual(4)
        await expect(lake.getLatestVersion(busy.id)).resolves.toMatchObject({
          versionId: busyLatest.versionId,
        })

        // An append's parent sits on the other side of the history.
        const append = await lake.beginWrite({ dataset: first, mode: "append" })
        await append.writeRows([{ id: "appended" }])
        const appended = await append.commit()
        const version = await counted(() => lake.getVersion(first.id, appended.versionId))
        expect(version.result?.parentVersionId).toBe(originals.get(first.id)?.versionId)
        expect(version.queries).toBeLessThanOrEqual(5)
        await expect(lake.listVersions(first.id)).resolves.toMatchObject([
          { versionId: appended.versionId, mode: "append" },
          { versionId: originals.get(first.id)?.versionId, mode: "snapshot" },
        ])

        // An idle feed read is one query; a busy one reports each dataset once.
        const second = others[0]
        if (!second) throw new Error("Missing stale dataset")
        const secondLatest = await commit(lake, second, "changed")
        const changed = await counted(() => lake.listLatestVersionsSince({ cursor }))
        expect(
          changed.result?.versions
            .map(({ datasetId, versionId }) => ({ datasetId, versionId }))
            .sort((left, right) => left.datasetId.localeCompare(right.datasetId))
        ).toEqual([
          { datasetId: first.id, versionId: appended.versionId },
          { datasetId: second.id, versionId: secondLatest.versionId },
        ])
        const idle = await counted(() =>
          lake.listLatestVersionsSince({ cursor: changed.result?.cursor ?? null })
        )
        expect(idle.result?.versions).toEqual([])
        expect(idle.queries).toBe(1)
      } finally {
        query.mockRestore()
      }
    }, 60_000)
  }

  test("rejects a cursor that is not a position in the lake", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-history-cursor-"))
    storage = createLocalDuckLakeStorage(rootDir)
    await storage.createDataset(busy)
    const head = await storage.listLatestVersionsSince({ cursor: null })

    await expect(
      storage.listLatestVersionsSince({ cursor: String(Number(head?.cursor) + 1_000) })
    ).resolves.toBeNull()
    await expect(storage.listLatestVersionsSince({ cursor: "not-a-snapshot" })).resolves.toBeNull()
  })
})

async function commit(storage: DuckLakeStorage, dataset: DatasetDefinition, id: string) {
  const write = await storage.beginWrite({ dataset, mode: "snapshot" })
  await write.writeRows([{ id }])
  return write.commit()
}

/** Appends Sixb commits to the busy dataset, as inline DuckLake inserts, after the latest one. */
async function appendBusyHistory(
  runtime: DuckDbRuntime,
  rootDir: string,
  catalog: "duckdb"
): Promise<void> {
  const options = localDuckLakeOptions(rootDir, catalog)
  const table = (name: string) => duckLakeMetadataTableName(options, name)
  const [busyTable] = await runtime.query(`
    SELECT table_id FROM ${table("ducklake_table")}
    WHERE table_name = ${quoteSqlString(encodeDatasetTableName(busy.id))} AND end_snapshot IS NULL
  `)
  const metadata = (snapshotId: string) =>
    `'{"sixb":{"kind":"datasetVersion","datasetId":"${busy.id}","commitId":"history-' || ${snapshotId} || '","mode":"append"}}'`

  await runtime.run(`
    INSERT INTO ${table("ducklake_snapshot")}
      (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id)
    SELECT
      latest.snapshot_id + offsets.n,
      latest.snapshot_time + to_seconds(offsets.n),
      latest.schema_version,
      latest.next_catalog_id,
      latest.next_file_id
    FROM (SELECT * FROM ${table("ducklake_snapshot")} ORDER BY snapshot_id DESC LIMIT 1) latest,
      range(1, ${HISTORY_LENGTH + 1}) offsets(n)
  `)
  await runtime.run(`
    INSERT INTO ${table("ducklake_snapshot_changes")}
      (snapshot_id, changes_made, author, commit_message, commit_extra_info)
    SELECT
      snapshot_id,
      'inlined_insert:${busyTable?.table_id}',
      'Sixb',
      'history',
      ${metadata("snapshot_id")}
    FROM ${table("ducklake_snapshot")}
    WHERE snapshot_id NOT IN (SELECT snapshot_id FROM ${table("ducklake_snapshot_changes")})
  `)
}
