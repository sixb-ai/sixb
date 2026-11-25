import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { change, col, type DatasetDefinition, defineDataset } from "@sixb/core"
import type { DatasetVersionRef } from "@sixb/core/lake-storage"
import { DuckLakeStorage } from "../src"
import type { DuckLakeConnectionManager } from "../src/internal/ducklake-connection-manager"
import { resolveDatasetTableRef } from "../src/internal/ducklake-dataset-table-ref"
import type { DuckLakeSnapshotReader } from "../src/internal/ducklake-snapshot-reader"
import { parseVersionId } from "../src/internal/versions"
import { collectRows, createLocalDuckLakeStorage, localDuckLakeOptions } from "./test-utils"

// A branch writes over the slice it was cut with: its versions are its own, their changes read at
// a cost that follows what it changed, and its maintenance never touches production's files.

const orders = defineDataset("branch.writes.orders", {
  schema: [col("id", "string"), col("customer", "string"), col("total", "float64")],
  primaryKey: "id",
})

let rootDir: string
let production: DuckLakeStorage
let route: ReturnType<typeof serve> | undefined

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-branch-writes-"))
  await mkdir(join(rootDir, "production"))
  production = createLocalDuckLakeStorage(join(rootDir, "production"))
})

afterEach(async () => {
  setSystemTime()
  route?.stop()
  route = undefined
  await production.close()
  await rm(rootDir, { recursive: true, force: true })
})

describe("a branch writing over its slice", () => {
  test("commits versions marked as its own, above production's", async () => {
    await write(orders, rows(1_000))
    const { branch, version } = await openBranch()
    try {
      const merge = await branch.beginMerge({ dataset: orders })
      await merge.writeChanges([change.upsert({ id: "o-1", customer: "Branch", total: 1 })])
      const committed = await merge.commit()
      const versionId = `${committed.version?.versionId}`

      expect(versionId).toBe("ducklake:branch:1")
      expect(branch.fork?.ownsVersion(versionId)).toBe(true)
      expect(branch.fork?.ownsVersion(version.versionId)).toBe(false)
      expect((await branch.listVersions(orders.id)).map((listed) => listed.versionId)).toEqual([
        versionId,
        version.versionId,
      ])
      // Production never takes a branch's version for one of its own.
      expect(await production.getVersion(orders.id, versionId)).toBeNull()
      expect(production.fork).toBeUndefined()
    } finally {
      await branch.close()
    }
  })

  // Red check: in DuckLakeSnapshotReader.readChangeRange, count every snapshot from the
  // production version, as on production's lake: the range reads as expired, and the change read
  // compares both versions in full.
  test("reads its changes since production's version from the change feed", async () => {
    await write(orders, rows(200_000))
    const { branch, version } = await openBranch()
    try {
      const merge = await branch.beginMerge({ dataset: orders })
      await merge.writeChanges([
        ...Array.from({ length: 50 }, (_, index) => change.delete({ id: `o-${index * 11}` })),
        ...Array.from({ length: 50 }, (_, index) =>
          change.upsert({ id: `o-new-${index}`, customer: "Branch", total: index })
        ),
      ])
      const committed = await merge.commit()
      const to = `${committed.version?.versionId}`

      const changes = await branch.readChanges({
        datasetId: orders.id,
        fromVersionId: version.versionId,
        toVersionId: to,
        keyColumns: ["id"],
        columns: ["id", "customer", "total"],
      })
      let count = 0
      for await (const _ of changes?.changes ?? []) count += 1
      await changes?.close()

      // The feed covers the slice: production's history before the version is not this catalog's.
      const internals = branch as unknown as {
        readonly connections: DuckLakeConnectionManager
        readonly snapshotReader: DuckLakeSnapshotReader
      }
      const range = await internals.connections.withAttachedRuntime(async (runtime) => {
        const table = await resolveDatasetTableRef(
          localDuckLakeOptions(rootDir),
          runtime,
          orders.id
        )
        if (!table) throw new Error("No table")
        return internals.snapshotReader.readChangeRange(
          runtime,
          table,
          parseVersionId(version.versionId),
          parseVersionId(to),
          512
        )
      })

      expect(count).toBe(100)
      expect(range?.complete).toBe(true)
      expect(range?.versions.map((listed) => listed.snapshotId)).toEqual([
        parseVersionId(version.versionId),
        parseVersionId(to),
      ])
    } finally {
      await branch.close()
    }
  })

  // Red check: in DuckLakeMaintenance.applyRetention, leave production's snapshots unprotected:
  // they expire with their age, and the branch can no longer read the version it was cut with.
  test("runs retention without expiring production's versions or deleting their files", async () => {
    await write(orders, rows(5_000))
    const { branch, version } = await openBranch()
    try {
      // Replacing every row leaves production's file unread by the branch's latest version.
      const replace = await branch.beginWrite({ dataset: orders, mode: "snapshot" })
      await replace.writeRows(rows(10).map((row) => ({ ...row, customer: "Replaced" })))
      await replace.commit()
      const merge = await branch.beginMerge({ dataset: orders })
      await merge.writeChanges([change.upsert({ id: "o-1", customer: "Again", total: 2 })])
      await merge.commit()

      // DuckLake stamps commits with the real clock: retention looks four hours later.
      setSystemTime(new Date(Date.now() + 4 * 60 * 60_000))
      const report = await branch.maintenance.applyRetention({
        keepVersionsForMs: 60 * 60_000,
        deleteFilesAfterMs: 60 * 60_000,
      })

      expect(report.expiredVersions).toBeGreaterThan(0)
      expect(route?.writes()).toBe(0)
      expect((await collectRows(branch.readRows(version))).length).toBe(4_999)
    } finally {
      await branch.close()
    }
  })
})

// Values that compress poorly, so reading them shows in the bytes production serves.
function rows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `o-${index}`,
    customer: `customer-${Bun.hash(`customer-${index}`).toString(36)}`,
    total: Number(Bun.hash(`total-${index}`) % 1_000_000n) / 7,
  }))
}

async function write(dataset: DatasetDefinition, values: Record<string, unknown>[]) {
  await production.createDataset(dataset)
  const session = await production.beginWrite({ dataset, mode: "snapshot" })
  await session.writeRows(values)
  await session.commit()
  const merge = await production.beginMerge({ dataset })
  await merge.writeChanges([change.delete({ id: "o-3" })])
  await merge.commit()
}

async function openBranch(): Promise<{ branch: DuckLakeStorage; version: DatasetVersionRef }> {
  const point = await production.forks.currentPoint()
  const at = await production.forks.versionsAt({ point, datasetIds: [orders.id] })
  const version = { datasetId: orders.id, versionId: `${at.get(orders.id)?.versionId}` }
  const slicePath = join(rootDir, "slice.ducklake")
  await production.forks.writeSlice({ point, versions: [version], path: slicePath })

  route = serve(await production.forks.listFiles([version]))
  return { branch: reopen("cache"), version }
}

/** The branch's lake, as a process with its own file cache opens it. */
function reopen(cache: string): DuckLakeStorage {
  return new DuckLakeStorage({
    catalog: { type: "duckdb", path: join(rootDir, "slice.ducklake") },
    dataPath: join(rootDir, "branch", "data"),
    productionFiles: {
      url: `${route?.url}`,
      token: () => "token",
      cacheDirectory: join(rootDir, "branch", cache),
    },
  })
}

/** Production's file route, reduced to the slice's files, counting what reaches it. */
function serve(listed: ReadonlySet<string>) {
  let bytes = 0
  let writes = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        writes += 1
        return new Response(null, { status: 405 })
      }
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
      const range = { start: Number(start), endInclusive: Number(end) }
      bytes += range.endInclusive - range.start + 1
      return new Response(file.read(range), { status: 206 })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/`,
    bytes: () => bytes,
    writes: () => writes,
    stop: () => server.stop(true),
  }
}
