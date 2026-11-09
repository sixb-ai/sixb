import { describe, expect, spyOn, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { change, col, type DatasetDefinition, defineDataset } from "@sixb/core"
import type { DatasetVersion, DatasetWriteCommitResult } from "@sixb/core/lake-storage"
import { SQL } from "bun"
import { type DuckDbSecretOptions, DuckLakeStorage, type DuckLakeStorageOptions } from "../src"
import type { DuckDbRuntime } from "../src/internal/duckdb-runtime"
import type { DuckLakeSnapshotReader } from "../src/internal/ducklake-snapshot-reader"
import { encodeDatasetTableName } from "../src/internal/names"
import { duckLakeMetadataTableName } from "../src/internal/sql"
import { collectRows } from "./test-utils"

describe("DuckLakeStorage remote catalogs", () => {
  for (const [budget, readers] of [
    [4, 4],
    [8, 4],
    [32, 16],
  ] as const) {
    test(`keeps writes available with four threads and ${readers} readers (pool ${budget})`, async () => {
      const options: DuckLakeStorageOptions = {
        catalog: { ...postgresCatalog(), applicationName: `sixb_reader_${randomId()}` },
        duckdb: { config: { threads: "4", memory_limit: "512MB" } },
        maxStreamingReads: readers,
        postgresPool: { maxConnections: budget, waitTimeoutMillis: 1_000 },
      }
      // Red check: reduce the connection reserve from four to three. The pool=4 fixture retains
      // a metadata transaction; an immediate append can time out depending on driver cleanup.
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "fixtures/reader-postgres-budget.ts"),
          JSON.stringify(options),
          String(readers),
        ],
        { stdout: "pipe", stderr: "pipe", timeout: 15_000 }
      )
      const [code, output, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ code, output, error }).toEqual({ code: 0, output: "", error: "" })
    }, 20_000)
  }

  // Regression proof: remove the DuckLake snapshot-CAS error classification; one child fails COMMIT.
  for (const scenario of ["different keys", "same key", "existing key", "deletion"] as const)
    test(`rebases source changes across processes: ${scenario}`, async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "sixb-source-processes-"))
      const dataset = defineDataset(`source.processes.${randomId()}`, {
        schema: [col("id", "string"), col("revision", "int64"), col("name", "string")],
        primaryKey: "id",
        sequenceBy: "revision",
      })
      const options: DuckLakeStorageOptions = {
        catalog: postgresCatalog(),
        dataPath: join(rootDir, "data"),
      }
      const storage = new DuckLakeStorage(options)
      await storage.createDataset(dataset)
      if (scenario === "existing key" || scenario === "deletion") {
        const seed = await storage.beginMerge({ dataset })
        await seed.writeChanges([change.upsert({ id: "42", revision: 7, name: "Seven" })])
        await seed.commit()
      }
      const children = [
        [change.upsert({ id: "42", revision: 8, name: "Eight" })],
        scenario === "deletion"
          ? [change.delete({ id: "42" }, { sequence: 9 })]
          : [
              change.upsert({
                id: scenario === "different keys" ? "other" : "42",
                revision: 9,
                name: "Nine",
              }),
            ],
      ].map((changes) => {
        let resolveReady!: () => void
        let rejectReady!: (error: Error) => void
        const ready = new Promise<void>((resolve, reject) => {
          resolveReady = resolve
          rejectReady = reject
        })
        const process = Bun.spawn(
          [
            Bun.argv[0],
            join(import.meta.dir, "fixtures/concurrent-source-merge.ts"),
            JSON.stringify(options),
            JSON.stringify(dataset),
            JSON.stringify(changes),
          ],
          {
            stdout: "ignore",
            stderr: "pipe",
            timeout: 30_000,
            ipc(message) {
              if (
                typeof message === "object" &&
                message !== null &&
                "type" in message &&
                message.type === "ready"
              )
                resolveReady()
            },
          }
        )
        const stderrText = new Response(process.stderr).text()
        const finished = process.exited.then(async (code) => {
          const stderr = await stderrText
          // Rejecting an already-resolved readiness promise has no effect.
          rejectReady(new Error(stderr || `child exited ${code} before reaching COMMIT`))
          return { code, stderr }
        })
        return { process, ready, finished }
      })
      try {
        // Both transactions reach COMMIT from the same base in independent Bun processes.
        await Promise.all(children.map((child) => child.ready))
        for (const child of children) child.process.send("commit")
        for (const child of children) {
          const { code, stderr } = await child.finished
          if (code !== 0) throw new Error(stderr)
        }
        const rows = await collectRows(storage.readRows({ datasetId: dataset.id }))
        if (scenario === "different keys")
          expect(rows.map((row) => row.id).sort()).toEqual(["42", "other"])
        else
          expect(rows).toEqual(
            scenario === "deletion" ? [] : [{ id: "42", revision: "9", name: "Nine" }]
          )
      } finally {
        for (const child of children) child.process.kill()
        await Promise.all(children.map((child) => child.finished))
        await storage.close()
        await rm(rootDir, { recursive: true, force: true })
      }
    }, 40_000)
  test("reads versions and changes over a long PostgreSQL catalog history", async () => {
    // Red check: restore the catalog-wide snapshot walk in querySnapshotCandidates. The stale read
    // then pages through 30k snapshots, about 235 queries, each copying catalog text out of
    // PostgreSQL. Production catalogs reach this length because snapshots are never expired.
    const rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-pg-history-"))
    const catalog = postgresCatalog()
    const storage = new DuckLakeStorage({ catalog, dataPath: join(rootDir, "data") })
    const datasetFor = (name: string) =>
      defineDataset(`raw.pg.history.${name}_${randomId()}`, { schema: [col("id", "string")] })
    const busy = datasetFor("busy")
    const stale = datasetFor("stale")
    const empty = datasetFor("empty")
    const commit = async (dataset: DatasetDefinition, ids: readonly string[]) => {
      const write = await storage.beginWrite({ dataset, mode: "snapshot" })
      await write.writeRows(ids.map((id) => ({ id })))
      return write.commit()
    }
    const adminSql = createAdminSql()

    try {
      for (const dataset of [busy, stale, empty]) await storage.createDataset(dataset)
      const original = await commit(stale, ["original"])
      await commit(busy, ["first"])
      await appendPostgresHistory(adminSql, catalog.metadataSchema ?? "main", busy.id, 30_000)
      const busyLatest = await commit(busy, ["after history"])
      // A first empty write is a metadata-only snapshot, found through its Sixb commit metadata.
      const emptyVersion = await commit(empty, [])
      const cursor = (await storage.listLatestVersionsSince({ cursor: null }))?.cursor ?? null

      const runtime = await (
        storage as unknown as { connections: { attachedRuntime(): Promise<DuckDbRuntime> } }
      ).connections.attachedRuntime()
      const query = spyOn(runtime, "query")
      const counted = async <T>(read: () => Promise<T>) => {
        query.mockClear()
        const result = await read()
        return { result, queries: query.mock.calls.length }
      }
      try {
        const latest = await counted(() => storage.getLatestVersion(stale.id))
        expect(latest.result?.versionId).toBe(original.versionId)
        expect(latest.queries).toBeLessThanOrEqual(4)
        await expect(storage.getLatestVersion(busy.id)).resolves.toMatchObject({
          versionId: busyLatest.versionId,
        })

        // Red check: gather the candidates from the table's data files and from every snapshot's
        // changes and commit metadata, then sort them, as 0.1.17 to 0.1.20 did. PostgreSQL then
        // reads the whole 30k-snapshot history for each of these lookups instead of a few rows.
        const [, previous] = await storage.listVersions(busy.id, 2)
        if (!previous) throw new Error("Missing the busy dataset's history")
        query.mockClear()
        await storage.getLatestVersion(busy.id)
        await expect(storage.getVersion(busy.id, previous.versionId)).resolves.toMatchObject({
          mode: "append",
          parentVersionId: expect.any(String),
        })
        const lookups = query.mock.calls.map(([sql]) => sql)
        expect(await rowsReadByPostgres(adminSql, lookups)).toBeLessThan(100)

        await expect(storage.getLatestVersion(empty.id)).resolves.toMatchObject({
          versionId: emptyVersion.versionId,
          mode: "snapshot",
        })

        const append = await storage.beginWrite({ dataset: stale, mode: "append" })
        await append.writeRows([{ id: "appended" }])
        const appended = await append.commit()
        await expect(storage.getVersion(stale.id, appended.versionId)).resolves.toMatchObject({
          parentVersionId: original.versionId,
        })

        const changed = await counted(() => storage.listLatestVersionsSince({ cursor }))
        expect(changed.result?.versions).toMatchObject([
          { datasetId: stale.id, versionId: appended.versionId, mode: "append" },
        ])
        const idle = await counted(() =>
          storage.listLatestVersionsSince({ cursor: changed.result?.cursor ?? null })
        )
        expect(idle.result?.versions).toEqual([])
        expect(idle.queries).toBe(1)
      } finally {
        query.mockRestore()
      }
    } finally {
      await storage.close()
      await adminSql.unsafe(
        `DROP SCHEMA IF EXISTS ${quotePgIdent(catalog.metadataSchema ?? "main")} CASCADE`
      )
      await adminSql.close()
      await rm(rootDir, { recursive: true, force: true })
    }
  }, 60_000)

  test("reads versions from a PostgreSQL catalog without a metadata schema", async () => {
    // Red check: name the default metadata schema `main`; the first version lookup then fails
    // because DuckLake wrote its tables to PostgreSQL's `public` schema.
    const rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-pg-default-schema-"))
    const database = `sixb_${randomId()}`
    const adminSql = createAdminSql()
    await adminSql.unsafe(`CREATE DATABASE ${quotePgIdent(database)}`)
    const { metadataSchema: _metadataSchema, ...catalog } = postgresCatalog()
    const storage = new DuckLakeStorage({
      catalog: { ...catalog, database },
      dataPath: join(rootDir, "data"),
    })
    const dataset = defineDataset("raw.pg.default_schema", { schema: [col("id", "string")] })

    try {
      await storage.createDataset(dataset)
      const head = await storage.listLatestVersionsSince({ cursor: null })
      const write = await storage.beginWrite({ dataset, mode: "snapshot" })
      await write.writeRows([{ id: "a" }])
      const version = await write.commit()

      await expect(storage.getLatestVersion(dataset.id)).resolves.toMatchObject({
        versionId: version.versionId,
      })
      await expect(
        storage.listLatestVersionsSince({ cursor: head?.cursor ?? null })
      ).resolves.toMatchObject({ versions: [{ versionId: version.versionId }] })
    } finally {
      await storage.close()
      await adminSql.unsafe(`DROP DATABASE IF EXISTS ${quotePgIdent(database)} WITH (FORCE)`)
      await adminSql.close()
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  // Regression proof: in readChangeRange, report every range incomplete. The read then compares
  // the two versions in full instead of reading the feed.
  test("reads a delta from the change feed of a PostgreSQL catalog", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-pg-feed-"))
    const storage = new DuckLakeStorage({
      catalog: postgresCatalog(),
      dataPath: join(rootDir, "data"),
    })
    const accounts = defineDataset(`crm.pg.feed.${randomId()}`, {
      schema: [col("id", "string"), col("name", "string")],
      primaryKey: "id",
    })
    const seed = Array.from({ length: 50_100 }, (_, i) => ({ id: `a${i}`, name: "seed" }))
    const snapshot = async (rows: readonly { id: string; name: string }[]) => {
      const write = await storage.beginWrite({ dataset: accounts, mode: "snapshot" })
      await write.writeRows(rows)
      return write.commit()
    }

    try {
      await storage.createDataset(accounts)
      const first = await snapshot(seed)
      await snapshot([...seed.slice(1), { id: "new", name: "added" }])
      const merge = await storage.beginMerge({ dataset: accounts })
      await merge.writeChanges([change.upsert({ id: "a2", name: "merged" })])
      const last = (await merge.commit()).version!

      const changes = (
        storage as unknown as { changes: { compareFeed(...args: unknown[]): Promise<boolean> } }
      ).changes
      const compareFeed = spyOn(changes, "compareFeed")
      const delta = await storage.readChanges({
        datasetId: accounts.id,
        fromVersionId: first.versionId,
        toVersionId: last.versionId,
        keyColumns: ["id"],
        columns: ["id", "name"],
      })
      const read: unknown[] = []
      try {
        for await (const change of delta!.changes) read.push(change)
      } finally {
        await delta?.close()
      }

      expect(await compareFeed.mock.results[0]?.value).toBe(true)
      expect(delta).toMatchObject({ fromRowCount: 50_100, toRowCount: 50_100, changeCount: 3 })
      const id = (change: unknown) => {
        const { before, after } = change as {
          before: { id: string } | null
          after: { id: string } | null
        }
        return (after ?? before)!.id
      }
      expect(read.sort((left, right) => id(left).localeCompare(id(right)))).toEqual([
        { before: { id: "a0", name: "seed" }, after: null },
        { before: { id: "a2", name: "seed" }, after: { id: "a2", name: "merged" } },
        { before: null, after: { id: "new", name: "added" } },
      ])
    } finally {
      await storage.close()
      await rm(rootDir, { recursive: true, force: true })
    }
  }, 60_000)

  // Regression proof: in DuckLakeMaintenance.planExpiry, expire the last version of each dataset,
  // or ignore `protect`. The idle dataset's version, or the protected one, then expires.
  test("keeps needed versions during retention of a PostgreSQL catalog", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-pg-maintenance-"))
    const idle = defineDataset(`raw.pg.idle.${randomId()}`, { schema: [col("id", "string")] })
    const busy = defineDataset(`raw.pg.busy.${randomId()}`, { schema: [col("id", "string")] })
    const options: DuckLakeStorageOptions = {
      catalog: postgresCatalog(),
      dataPath: join(rootDir, "data"),
    }
    const storage = new DuckLakeStorage(options)

    const commit = async (dataset: DatasetDefinition, id: string) => {
      const write = await storage.beginWrite({ dataset, mode: "snapshot" })
      await write.writeRows([{ id }])
      return write.commit()
    }

    try {
      await storage.createDataset(idle)
      await storage.createDataset(busy)

      const idleVersion = await commit(idle, "room_1")
      const replaced = await commit(busy, "reading_1")
      const applied = await commit(busy, "reading_2")
      await commit(busy, "reading_3")

      // Backdate the catalog's history instead of waiting for it to age.
      const runtime = await (
        storage as unknown as { connections: { attachedRuntime(): Promise<DuckDbRuntime> } }
      ).connections.attachedRuntime()
      await runtime.run(`
        UPDATE ${duckLakeMetadataTableName(options, "ducklake_snapshot")}
        SET snapshot_time = snapshot_time - INTERVAL '2 hours'
      `)

      const report = await storage.maintenance.applyRetention({
        keepVersionsForMs: 60 * 60 * 1000,
        protect: [{ datasetId: busy.id, versionId: applied.versionId }],
      })

      expect(report.keptVersions).toBe(1)
      expect(await storage.getVersion(busy.id, replaced.versionId)).toBeNull()
      expect(await storage.getVersion(busy.id, applied.versionId)).not.toBeNull()
      expect((await storage.getLatestVersion(idle.id))?.versionId).toBe(idleVersion.versionId)
      expect(await collectRows(storage.readRows({ datasetId: idle.id }))).toEqual([
        { id: "room_1" },
      ])
    } finally {
      await storage.close()
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  // Regression proof: in DuckLakeMaintenance, rethrow in yieldingToConcurrentPass. The pass that
  // loses a race fails with "could not serialize access due to concurrent update" (most rounds
  // have a loser with DuckLake ac7595b0).
  test("two retention passes at once on a PostgreSQL catalog both succeed", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-pg-retention-race-"))
    const dataset = defineDataset(`raw.pg.race.${randomId()}`, {
      schema: [col("id", "string"), col("n", "int64")],
    })
    const options: DuckLakeStorageOptions = {
      catalog: postgresCatalog(),
      dataPath: join(rootDir, "data"),
    }
    const first = new DuckLakeStorage(options)
    const second = new DuckLakeStorage(options)
    const retention = { keepVersionsForMs: 60 * 60 * 1000, deleteFilesAfterMs: 60 * 60 * 1000 }

    // Backdates the catalog's history and its scheduled files, instead of waiting for them.
    const backdate = async () => {
      const runtime = await (
        first as unknown as { connections: { attachedRuntime(): Promise<DuckDbRuntime> } }
      ).connections.attachedRuntime()
      for (const [table, column] of [
        ["ducklake_snapshot", "snapshot_time"],
        ["ducklake_files_scheduled_for_deletion", "schedule_start"],
      ] as const) {
        await runtime.run(`
          UPDATE ${duckLakeMetadataTableName(options, table)}
          SET ${column} = ${column} - INTERVAL '3 hours'
        `)
      }
    }

    try {
      await first.createDataset(dataset)
      let latest: DatasetWriteCommitResult | undefined
      for (let n = 0; n < 40; n++) {
        const write = await first.beginWrite({ dataset, mode: "snapshot" })
        await write.writeRows(Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, n })))
        latest = await write.commit()
      }

      // Two rounds: a provider that lost three in a row would fail, as it should (countYields).
      for (let round = 0; round < 2; round++) {
        await backdate()
        const passes = await Promise.allSettled([
          first.maintenance.applyRetention({ ...retention, limit: 8 }),
          second.maintenance.applyRetention({ ...retention, limit: 8 }),
        ])
        expect(passes.map((pass) => pass.status)).toEqual(["fulfilled", "fulfilled"])
      }

      await backdate()
      await first.maintenance.applyRetention(retention)
      await backdate()
      expect(await first.maintenance.applyRetention(retention)).toMatchObject({ hasMore: false })

      expect((await second.getLatestVersion(dataset.id))?.versionId).toBe(latest?.versionId)
      expect(await collectRows(second.readRows({ datasetId: dataset.id }))).toHaveLength(20)
      expect(await second.listVersions(dataset.id)).toHaveLength(1)
    } finally {
      await first.close()
      await second.close()
      await rm(rootDir, { recursive: true, force: true })
    }
  }, 60_000)

  test("uses a PostgreSQL catalog with an S3-compatible data path", async () => {
    const dataset = defineDataset(`raw.pg.s3.${randomId()}`, {
      schema: [col("orderId", "string")],
    })
    const storage = new DuckLakeStorage({
      catalog: postgresCatalog(),
      dataPath: `s3://${s3Bucket()}/lake/${randomId()}`,
      secrets: [s3Secret()],
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

  test("releasing idle memory drops the files DuckDB cached from S3", async () => {
    // Red check: remove the enable_external_file_cache toggle from releaseMemory(); the cached
    // ranges stay.
    const dataset = defineDataset(`raw.pg.s3.cache.${randomId()}`, {
      schema: [col("orderId", "string")],
    })
    const storage = new DuckLakeStorage({
      catalog: postgresCatalog(),
      dataPath: `s3://${s3Bucket()}/lake/${randomId()}`,
      secrets: [s3Secret()],
      duckdb: { releaseMemoryAfterIdleMs: false },
    })
    const rows = Array.from({ length: 100 }, (_, i) => ({ orderId: `ord_${i}` }))
    const cachedRanges = async (runtime: DuckDbRuntime) => {
      const [row] = await runtime.query(
        "SELECT count(*)::INTEGER AS ranges FROM duckdb_external_file_cache()"
      )
      return row?.ranges
    }

    try {
      await storage.createDataset(dataset)
      const write = await storage.beginWrite({ dataset, mode: "snapshot" })
      await write.writeRows(rows)
      await write.commit()
      expect(await collectRows(storage.readRows({ datasetId: dataset.id }))).toHaveLength(100)

      const runtime = await (
        storage as unknown as { connections: { attachedRuntime(): Promise<DuckDbRuntime> } }
      ).connections.attachedRuntime()
      expect(await cachedRanges(runtime)).toBeGreaterThan(0)

      await runtime.releaseMemory()
      expect(await cachedRanges(runtime)).toBe(0)
      // The cache is back on for the next read.
      expect(await collectRows(storage.readRows({ datasetId: dataset.id }))).toHaveLength(100)
      expect(await cachedRanges(runtime)).toBeGreaterThan(0)
    } finally {
      await storage.close()
    }
  })

  describe("a version commits on the version it read", () => {
    const events = () =>
      defineDataset(`raw.pg.events.${randomId()}`, {
        schema: [col("id", "string"), col("v", "string")],
      })
    const secret = { datasetId: "hr.secret", column: "ssn" }
    const leaked = { rows: [], columns: { id: [], v: [secret] } }

    /**
     * Two provider instances on one catalog. `other` commits a pipeline append that copies a
     * secret into `v` while `run` is between reading its parent and committing.
     */
    async function race<T>(
      run: (input: {
        readonly storage: DuckLakeStorage
        readonly dataset: ReturnType<typeof events>
        readonly concurrently: () => Promise<void>
      }) => Promise<T>
    ): Promise<{ readonly result: T; readonly concurrent: DatasetVersion }> {
      const rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-pg-race-"))
      const options: DuckLakeStorageOptions = {
        catalog: postgresCatalog(),
        dataPath: join(rootDir, "data"),
      }
      const storage = new DuckLakeStorage(options)
      const other = new DuckLakeStorage(options)
      const dataset = events()

      try {
        await storage.createDataset(dataset)
        await other.createDataset(dataset)

        const seed = await storage.beginWrite({ dataset, producer: { kind: "sync", id: "erp" } })
        await seed.writeRows([{ id: "1", v: "seed" }])
        const parent = await seed.commit()

        let concurrent: DatasetVersion | undefined
        const result = await run({
          storage,
          dataset,
          concurrently: async () => {
            if (concurrent) return
            const write = await other.beginWrite({
              dataset,
              mode: "append",
              producer: { kind: "pipeline", id: "copy", stepId: "ssn" },
              lineage: leaked,
            })
            await write.writeRows([{ id: "2", v: "123-45-6789" }])
            concurrent = await write.commit({ expectedLatestVersionId: parent.versionId })
          },
        })

        if (!concurrent) throw new Error("[Test] The concurrent commit never ran.")
        return { result, concurrent }
      } finally {
        await storage.close()
        await other.close()
        await rm(rootDir, { recursive: true, force: true })
      }
    }

    /** Runs `concurrently` right after `storage` read its parent inside the transaction. */
    function afterParentRead(storage: DuckLakeStorage, concurrently: () => Promise<void>) {
      const reader = (storage as unknown as { snapshotReader: DuckLakeSnapshotReader })
        .snapshotReader
      const read = reader.getLatestVersionSummaryAtCurrentSnapshot.bind(reader)
      return spyOn(reader, "getLatestVersionSummaryAtCurrentSnapshot").mockImplementation(
        async (...args) => {
          const summary = await read(...args)
          await concurrently()
          return summary
        }
      )
    }

    /** Two provider instances on one catalog, over one new dataset without versions. */
    async function twoWriters<T, D extends DatasetDefinition = ReturnType<typeof events>>(
      run: (input: {
        readonly storage: DuckLakeStorage
        readonly other: DuckLakeStorage
        readonly dataset: D
        readonly schemaVersion: () => Promise<bigint>
      }) => Promise<T>,
      dataset: D = events() as D
    ): Promise<T> {
      const rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-pg-writers-"))
      const options: DuckLakeStorageOptions = {
        catalog: postgresCatalog(),
        dataPath: join(rootDir, "data"),
      }
      const storage = new DuckLakeStorage(options)
      const other = new DuckLakeStorage(options)

      try {
        await storage.createDataset(dataset)
        await other.createDataset(dataset)

        const schemaVersion = async () => {
          const runtime = await (
            storage as unknown as { connections: { attachedRuntime(): Promise<DuckDbRuntime> } }
          ).connections.attachedRuntime()
          const [row] = await runtime.query(
            `SELECT max(schema_version) AS version FROM ${duckLakeMetadataTableName(options, "ducklake_snapshot")}`
          )
          return BigInt(String(row?.version))
        }

        return await run({ storage, other, dataset, schemaVersion })
      } finally {
        await storage.close()
        await other.close()
        await rm(rootDir, { recursive: true, force: true })
      }
    }

    /** Runs `concurrently` once, right before `storage` stores its commit metadata. */
    function beforeCommitMetadata(storage: DuckLakeStorage, concurrently: () => Promise<void>) {
      const writes = (
        storage as unknown as { writes: { setCommitMetadata(...args: unknown[]): Promise<void> } }
      ).writes
      const setCommitMetadata = writes.setCommitMetadata.bind(writes)
      let ran = false

      return spyOn(writes, "setCommitMetadata").mockImplementation(async (...args) => {
        if (!ran) {
          ran = true
          await concurrently()
        }
        return setCommitMetadata(...args)
      })
    }

    /**
     * Runs `concurrently` once, right before `storage` reads the latest version a write that
     * changes no rows compares with, whichever read that is: after the rows were compared.
     */
    function beforeUnchangedBaseline(storage: DuckLakeStorage, concurrently: () => Promise<void>) {
      const reader = (storage as unknown as { snapshotReader: DuckLakeSnapshotReader })
        .snapshotReader
      let ran = false
      const once = async () => {
        if (ran) return
        ran = true
        await concurrently()
      }

      const forDefinition = reader.getLatestVersionSummaryForDefinition.bind(reader)
      const atCurrentSnapshot = reader.getLatestVersionSummaryAtCurrentSnapshot.bind(reader)
      const spies = [
        spyOn(reader, "getLatestVersionSummaryForDefinition").mockImplementation(
          async (...args) => {
            await once()
            return forDefinition(...args)
          }
        ),
        spyOn(reader, "getLatestVersionSummaryAtCurrentSnapshot").mockImplementation(
          async (...args) => {
            await once()
            return atCurrentSnapshot(...args)
          }
        ),
      ]

      return () => {
        for (const spy of spies) spy.mockRestore()
      }
    }

    const write = async (
      storage: DuckLakeStorage,
      dataset: DatasetDefinition,
      input: Omit<Parameters<DuckLakeStorage["beginWrite"]>[0], "dataset">,
      rows: readonly { id: string; v: string }[]
    ) => {
      const session = await storage.beginWrite({ dataset, ...input })
      await session.writeRows(rows)
      return session.commit()
    }

    // Regression proof: let a snapshot that deleted no rows commit without its claim. The later
    // snapshot then commits over the earlier one and keeps its rows, which it replaces.
    test("two snapshots of an empty dataset replace each other", async () => {
      const rows = await twoWriters(async ({ storage, other, dataset }) => {
        const spy = beforeCommitMetadata(storage, async () => {
          await write(other, dataset, { producer: { kind: "sync", id: "b" } }, [
            { id: "b", v: "other" },
          ])
        })
        try {
          await write(storage, dataset, { producer: { kind: "sync", id: "a" } }, [
            { id: "a", v: "mine" },
          ])
        } finally {
          spy.mockRestore()
        }
        return collectRows(storage.readRows({ datasetId: dataset.id }))
      })

      expect(rows).toEqual([{ id: "a", v: "mine" }])
    }, 60_000)

    // Regression proof: let an append into an empty dataset commit without its claim. The
    // snapshot, which read the dataset empty too, then deletes nothing and keeps the appended rows.
    test("a snapshot of an empty dataset replaces the rows of a concurrent append", async () => {
      const rows = await twoWriters(async ({ storage, other, dataset }) => {
        const spy = beforeCommitMetadata(storage, async () => {
          await write(other, dataset, { mode: "append", producer: { kind: "sync", id: "b" } }, [
            { id: "b", v: "other" },
          ])
        })
        try {
          await write(storage, dataset, { producer: { kind: "sync", id: "a" } }, [
            { id: "a", v: "mine" },
          ])
        } finally {
          spy.mockRestore()
        }
        return collectRows(storage.readRows({ datasetId: dataset.id }))
      })

      expect(rows).toEqual([{ id: "a", v: "mine" }])
    }, 60_000)

    // Regression proof: let a snapshot that deleted no rows commit without its claim. The append
    // then commits over it unseen, and records no lineage for the rows it copied from a secret.
    test("an append over a snapshot of an empty dataset keeps that snapshot's lineage", async () => {
      const appended = await twoWriters(async ({ storage, other, dataset }) => {
        const spy = afterParentRead(storage, async () => {
          await write(
            other,
            dataset,
            { producer: { kind: "pipeline", id: "copy", stepId: "ssn" }, lineage: leaked },
            [{ id: "1", v: "123-45-6789" }]
          )
        })
        try {
          return await write(
            storage,
            dataset,
            { mode: "append", producer: { kind: "sync", id: "ingest" } },
            [{ id: "2", v: "x" }]
          )
        } finally {
          spy.mockRestore()
        }
      })

      expect(appended.lineage).toEqual(leaked)
    }, 60_000)

    // Regression proof: let a keyed append or merge into a dataset with rows commit without its
    // claim. DuckLake has no primary key, and both writes of the new key commit.
    for (const mode of ["append", "merge"] as const) {
      test(`keyed ${mode}s of one new key over each other keep the key unique`, async () => {
        const keyed = defineDataset(`raw.pg.keyed.${randomId()}`, {
          schema: [col("id", "string"), col("v", "string")],
          primaryKey: "id",
        })
        const sync = { producer: { kind: "sync", id: "erp" } } as const
        const upsert = async (storage: DuckLakeStorage, v: string) => {
          if (mode === "append") {
            return write(storage, keyed, { ...sync, mode: "append" }, [{ id: "2", v }])
          }

          const merge = await storage.beginMerge({ dataset: keyed, ...sync })
          await merge.writeChanges([change.upsert({ id: "2", v })])
          return merge.commit()
        }

        const { error, rows } = await twoWriters(async ({ storage, other, dataset }) => {
          await write(storage, dataset, sync, [{ id: "1", v: "seed" }])

          const spy = beforeCommitMetadata(storage, async () => {
            await upsert(other, "theirs")
          })
          try {
            const error = await upsert(storage, "mine").then(
              () => undefined,
              (failure: unknown) => failure
            )
            return { error, rows: await collectRows(storage.readRows({ datasetId: dataset.id })) }
          } finally {
            spy.mockRestore()
          }
        }, keyed)

        // The rerun finds the key: an append rejects it, a merge on its stale base gives up.
        expect(String(error)).toContain(
          mode === "append" ? "duplicate primary key" : "Optimistic merge commit failed"
        )
        expect(rows).toEqual([
          { id: "1", v: "seed" },
          { id: "2", v: "theirs" },
        ])
      }, 60_000)
    }

    /**
     * A keyed dataset seeded with two files of 200 rows, `f1_*` and `f2_*`. Deleting 15 rows of
     * one writes a delete file, as more than 10 do, and stays under the share that compaction
     * rewrites.
     */
    async function twoKeyedFiles<T>(
      run: (input: {
        readonly storage: DuckLakeStorage
        readonly other: DuckLakeStorage
        readonly dataset: DatasetDefinition
        readonly seed: readonly { id: string; v: string }[]
        readonly schemaVersion: () => Promise<bigint>
      }) => Promise<T>
    ): Promise<T> {
      const keyed = defineDataset(`raw.pg.keyed.${randomId()}`, {
        schema: [col("id", "string"), col("v", "string")],
        primaryKey: "id",
      })
      const file = (n: number) =>
        Array.from({ length: 200 }, (_, i) => ({ id: `f${n}_${i}`, v: "seed" }))

      return twoWriters(async ({ storage, other, dataset, schemaVersion }) => {
        for (const n of [1, 2]) {
          await write(storage, dataset, { mode: "append" }, file(n))
        }

        return run({ storage, other, dataset, seed: [...file(1), ...file(2)], schemaVersion })
      }, keyed)
    }

    const sortedRows = async (storage: DuckLakeStorage, dataset: DatasetDefinition) =>
      (await collectRows(storage.readRows({ datasetId: dataset.id }))).sort((left, right) =>
        String(left.id).localeCompare(String(right.id))
      )

    const sortedById = (rows: readonly { id: string; v: string }[]) =>
      [...rows].sort((left, right) => left.id.localeCompare(right.id))

    // Regression proof: in applyKeyedSnapshot, stop rewriting an unchanged row for a difference
    // that only inserts or only deletes. Two inserts never conflict, nor deletes from different
    // files, so both snapshots commit, and the dataset holds a mix of the two.
    for (const shape of ["adds", "removes"] as const) {
      test(`two keyed snapshots that only ${shape === "adds" ? "add" : "remove"} rows do not both commit`, async () => {
        const { rows, mine } = await twoKeyedFiles(async ({ storage, other, dataset, seed }) => {
          const mine =
            shape === "adds"
              ? [...seed, { id: "mine", v: "new" }]
              : seed.filter((row) => !/^f1_\d$|^f1_1[0-4]$/.test(row.id))
          const theirs =
            shape === "adds"
              ? [...seed, { id: "theirs", v: "new" }]
              : seed.filter((row) => !/^f2_\d$|^f2_1[0-4]$/.test(row.id))

          const spy = beforeCommitMetadata(storage, async () => {
            await write(other, dataset, { mode: "snapshot" }, theirs)
          })
          try {
            await write(storage, dataset, { mode: "snapshot" }, mine)
          } finally {
            spy.mockRestore()
          }

          return { rows: await sortedRows(storage, dataset), mine }
        })

        // The later snapshot reran on the earlier one, and holds exactly its own rows.
        expect(rows).toEqual(sortedById(mine))
      }, 60_000)
    }

    // Regression proof: in mustClaimTable, claim every snapshot. Both snapshots then bump the
    // catalog's schema version.
    test("keyed snapshots that update rows of different files conflict without claiming", async () => {
      const { rows, mine, bumped } = await twoKeyedFiles(
        async ({ storage, other, dataset, seed, schemaVersion }) => {
          const update = (id: string) =>
            seed.map((row) => (row.id === id ? { ...row, v: "changed" } : row))
          const mine = update("f1_0")
          const before = await schemaVersion()

          const spy = beforeCommitMetadata(storage, async () => {
            await write(other, dataset, { mode: "snapshot" }, update("f2_0"))
          })
          try {
            await write(storage, dataset, { mode: "snapshot" }, mine)
          } finally {
            spy.mockRestore()
          }

          const bumped = (await schemaVersion()) !== before
          return { rows: await sortedRows(storage, dataset), mine, bumped }
        }
      )

      expect(bumped).toBe(false)
      expect(rows).toEqual(sortedById(mine))
    }, 60_000)

    // Regression proof: commit versions that change no rows on top of unseen snapshots. The
    // version of new provenance then lands on the concurrent snapshot, which deleted rows but did
    // not claim the table, and stands for rows it never compared.
    test("a version of new provenance over a concurrent snapshot that replaced rows reruns", async () => {
      const notes = {
        rows: [],
        columns: { id: [], v: [{ datasetId: "crm.notes", column: "text" }] },
      }
      const { version, rows } = await twoWriters(async ({ storage, other, dataset }) => {
        await write(storage, dataset, { producer: { kind: "sync", id: "erp" } }, [
          { id: "1", v: "seed" },
        ])

        const spy = beforeCommitMetadata(storage, async () => {
          await write(other, dataset, { producer: { kind: "sync", id: "erp" } }, [
            { id: "2", v: "other" },
          ])
        })
        try {
          const version = await write(
            storage,
            dataset,
            { producer: { kind: "pipeline", id: "copy", stepId: "notes" }, lineage: notes },
            [{ id: "1", v: "seed" }]
          )
          const rows = await collectRows(
            storage.readRows({ datasetId: dataset.id, versionId: version.versionId })
          )
          return { version, rows }
        } finally {
          spy.mockRestore()
        }
      })

      expect(version).toMatchObject({ outcome: "created", lineage: notes })
      expect(rows).toEqual([{ id: "1", v: "seed" }])
    }, 60_000)

    // Regression proof: commit schema changes on top of unseen snapshots. The schema change then
    // lands on the concurrent pipeline snapshot, which did not claim the table, and keeps the
    // lineage of the rows that snapshot replaced.
    test("a schema change over a concurrent snapshot that replaced rows keeps its lineage", async () => {
      const result = await twoWriters(async ({ storage, other, dataset }) => {
        await write(storage, dataset, { producer: { kind: "sync", id: "erp" } }, [
          { id: "1", v: "seed" },
        ])

        let concurrent: DatasetVersion | undefined
        const spy = afterParentRead(storage, async () => {
          if (concurrent) return
          concurrent = await write(
            other,
            dataset,
            { producer: { kind: "pipeline", id: "copy", stepId: "ssn" }, lineage: leaked },
            [{ id: "2", v: "123-45-6789" }]
          )
        })
        try {
          await storage.createDataset(
            defineDataset(dataset.id, {
              schema: [...dataset.schema.columns, col("note", "string", { nullable: true })],
            })
          )
          return { schema: (await storage.listVersions(dataset.id, 1))[0], concurrent }
        } finally {
          spy.mockRestore()
        }
      })

      expect(result.schema).toMatchObject({
        mode: "schema",
        parentVersionId: result.concurrent?.versionId,
      })
      expect(result.schema?.lineage).toEqual({
        rows: [],
        columns: { id: [], note: [], v: [secret] },
      })
    }, 60_000)

    // Regression proof: commit guarded unkeyed appends on top of unseen snapshots. The guarded
    // append then lands on the concurrent append, which did not claim the table, although its
    // guard named the version before it.
    test("an unkeyed append guarded on its parent fails over a concurrent append", async () => {
      const { error, rows } = await twoWriters(async ({ storage, other, dataset }) => {
        const sync = { producer: { kind: "sync", id: "erp" } } as const
        const parent = await write(storage, dataset, sync, [{ id: "1", v: "seed" }])

        const spy = beforeCommitMetadata(storage, async () => {
          await write(other, dataset, { ...sync, mode: "append" }, [{ id: "2", v: "theirs" }])
        })
        try {
          const session = await storage.beginWrite({ dataset, ...sync, mode: "append" })
          await session.writeRows([{ id: "3", v: "mine" }])
          const error = await session.commit({ expectedLatestVersionId: parent.versionId }).then(
            () => undefined,
            (failure: unknown) => failure
          )
          return { error, rows: await collectRows(storage.readRows({ datasetId: dataset.id })) }
        } finally {
          spy.mockRestore()
        }
      })

      expect(String(error)).toContain("Optimistic commit failed")
      expect(rows.map((row) => row.id).sort()).toEqual(["1", "2"])
    }, 60_000)

    // Regression proof: claim the table on every commit. Each sync append then bumps DuckLake's
    // catalog-wide schema version, and concurrent writers to the dataset conflict and rerun.
    test("sync writes to a dataset no pipeline writes commit concurrently without a claim", async () => {
      const result = await twoWriters(async ({ storage, other, dataset, schemaVersion }) => {
        const sync = { producer: { kind: "sync", id: "erp" } } as const
        await write(storage, dataset, sync, [{ id: "1", v: "seed" }])
        const before = await schemaVersion()

        const metadata = spyOn(
          (storage as unknown as { writes: { setCommitMetadata(): Promise<void> } }).writes,
          "setCommitMetadata"
        )
        const spy = afterParentRead(storage, async () => {
          if (metadata.mock.calls.length > 0) return
          await write(other, dataset, { ...sync, mode: "append" }, [{ id: "2", v: "theirs" }])
        })
        try {
          const appended = await write(storage, dataset, { ...sync, mode: "append" }, [
            { id: "3", v: "mine" },
          ])
          const attempts = metadata.mock.calls.length
          const rows = await collectRows(storage.readRows({ datasetId: dataset.id }))
          // A snapshot that replaces rows conflicts with any concurrent change without a claim.
          await write(storage, dataset, sync, [{ id: "4", v: "replaced" }])
          return {
            appended,
            attempts,
            schemaVersionChange: (await schemaVersion()) - before,
            rows,
          }
        } finally {
          spy.mockRestore()
          metadata.mockRestore()
        }
      })

      expect(result.schemaVersionChange).toBe(0n)
      expect(result.attempts).toBe(1)
      expect(result.appended.lineage).toEqual({ rows: [], columns: { id: [], v: [] } })
      expect(result.rows.map((row) => row.id).sort()).toEqual(["1", "2", "3"])
    }, 60_000)

    // Regression proof: claim only the versions of datasets that hold nothing but their own
    // columns, never a pipeline append. Two pipeline appends then commit over each other, and
    // the later one drops the lineage of the earlier one's rows.
    test("pipeline appends claim, conflict, and rerun on each other's lineage", async () => {
      const notes = { datasetId: "crm.notes", column: "text" }
      const result = await twoWriters(async ({ storage, other, dataset }) => {
        await write(storage, dataset, { producer: { kind: "sync", id: "erp" } }, [
          { id: "1", v: "seed" },
        ])

        const metadata = spyOn(
          (storage as unknown as { writes: { setCommitMetadata(): Promise<void> } }).writes,
          "setCommitMetadata"
        )
        const spy = afterParentRead(storage, async () => {
          if (metadata.mock.calls.length > 0) return
          await write(
            other,
            dataset,
            {
              mode: "append",
              producer: { kind: "pipeline", id: "copy", stepId: "ssn" },
              lineage: leaked,
            },
            [{ id: "2", v: "123-45-6789" }]
          )
        })
        try {
          const appended = await write(
            storage,
            dataset,
            {
              mode: "append",
              producer: { kind: "pipeline", id: "copy", stepId: "notes" },
              lineage: { rows: [], columns: { id: [], v: [notes] } },
            },
            [{ id: "3", v: "note" }]
          )
          return { appended, attempts: metadata.mock.calls.length }
        } finally {
          spy.mockRestore()
          metadata.mockRestore()
        }
      })

      expect(result.attempts).toBe(2)
      expect(result.appended.lineage).toEqual({ rows: [], columns: { id: [], v: [notes, secret] } })
    }, 60_000)

    // Regression proof: drop the table claim, or fix the transaction's snapshot after the parent
    // read. DuckLake then commits the append on top of the concurrent one without a conflict,
    // and the append records the lineage of a parent it no longer sits on.
    // Regression proof: rerun 5 times without waiting between attempts. A writer that loses to
    // another starts its rerun behind it, loses again, and runs out of attempts. Each write
    // claims its keyed table, so every commit conflicts with every concurrent one.
    test("concurrent keyed appends to one dataset all commit", async () => {
      const writers = 6
      const writesPerWriter = 5
      const rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-pg-liveness-"))
      const options: DuckLakeStorageOptions = {
        catalog: postgresCatalog(),
        dataPath: join(rootDir, "data"),
      }
      const dataset = defineDataset(`raw.pg.liveness.${randomId()}`, {
        schema: [col("id", "string"), col("writer", "int64")],
        primaryKey: "id",
      })
      const storages = Array.from({ length: writers }, () => new DuckLakeStorage(options))

      // Seeded jitter: the same backoff sequence on every run.
      let seed = 0x5eed
      const random = spyOn(Math, "random").mockImplementation(() => {
        seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31
        return seed / 2 ** 31
      })
      try {
        for (const storage of storages) await storage.createDataset(dataset)
        await Promise.all(
          storages.map(async (storage, writer) => {
            for (let write = 0; write < writesPerWriter; write++) {
              const session = await storage.beginWrite({
                dataset,
                mode: "append",
                producer: { kind: "sync", id: `writer-${writer}` },
              })
              await session.writeRows([{ id: `${writer}-${write}`, writer }])
              await session.commit()
            }
          })
        )

        const rows = await collectRows(storages[0]!.readRows({ datasetId: dataset.id }))
        expect(rows.length).toBe(writers * writesPerWriter)
      } finally {
        random.mockRestore()
        for (const storage of storages) await storage.close()
        await rm(rootDir, { recursive: true, force: true })
      }
    }, 120_000)

    test("an append over a concurrent append reruns and keeps its lineage", async () => {
      const { result, concurrent } = await race(async ({ storage, dataset, concurrently }) => {
        const spy = afterParentRead(storage, concurrently)
        try {
          const write = await storage.beginWrite({
            dataset,
            mode: "append",
            producer: { kind: "sync", id: "ingest" },
          })
          await write.writeRows([{ id: "3", v: "x" }])
          const version = await write.commit()
          return { version, rows: await collectRows(storage.readRows({ datasetId: dataset.id })) }
        } finally {
          spy.mockRestore()
        }
      })

      expect(result.version.parentVersionId).toBe(concurrent.versionId)
      expect(result.version.lineage).toEqual(leaked)
      expect(result.rows.map((row) => row.id)).toEqual(["1", "2", "3"])
    }, 60_000)

    // Regression proof: drop the rerun of a schema change the catalog moved under. The schema
    // change then fails on the conflict, or with the snapshot fixed late, keeps a stale lineage.
    test("a schema change over a concurrent append reruns and keeps its lineage", async () => {
      const { result, concurrent } = await race(async ({ storage, dataset, concurrently }) => {
        const spy = afterParentRead(storage, concurrently)
        try {
          await storage.createDataset(
            defineDataset(dataset.id, {
              schema: [...dataset.schema.columns, col("note", "string", { nullable: true })],
            })
          )
          return (await storage.listVersions(dataset.id, 1))[0]
        } finally {
          spy.mockRestore()
        }
      })

      expect(result).toMatchObject({ mode: "schema", parentVersionId: concurrent.versionId })
      expect(result?.lineage).toEqual({ rows: [], columns: { id: [], note: [], v: [secret] } })
    }, 60_000)

    // Regression proof: rerun a schema change with the plan of its first attempt. The rerun then
    // adds a column the concurrent host already added, and the update fails.
    test("a schema change another host applied concurrently leaves nothing to apply", async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-pg-schema-"))
      const options: DuckLakeStorageOptions = {
        catalog: postgresCatalog(),
        dataPath: join(rootDir, "data"),
      }
      const storage = new DuckLakeStorage(options)
      const other = new DuckLakeStorage(options)
      const dataset = events()
      const widened = defineDataset(dataset.id, {
        schema: [...dataset.schema.columns, col("note", "string", { nullable: true })],
      })

      try {
        await storage.createDataset(dataset)
        await other.createDataset(dataset)
        const seed = await storage.beginWrite({ dataset })
        await seed.writeRows([{ id: "1", v: "seed" }])
        await seed.commit()

        let applied = false
        const spy = afterParentRead(storage, async () => {
          if (applied) return
          applied = true
          await other.createDataset(widened)
        })
        try {
          expect(await storage.createDataset(widened)).toMatchObject({ schema: widened.schema })
        } finally {
          spy.mockRestore()
        }
        expect((await storage.listVersions(dataset.id)).map((version) => version.mode)).toEqual([
          "schema",
          "snapshot",
        ])
      } finally {
        await storage.close()
        await other.close()
        await rm(rootDir, { recursive: true, force: true })
      }
    }, 60_000)

    // Regression proof, with new provenance: drop the table claim. The snapshot only reapplies the
    // table comment, which commits over the concurrent append. Without: drop the check that the
    // latest version is still the one the rows matched. The write then reports itself unchanged
    // and returns the concurrent version. Either way it stands for rows it did not write.
    for (const [provenance, lineage] of [
      ["new", { rows: [], columns: { id: [], v: [{ datasetId: "crm.notes", column: "text" }] } }],
      ["the same", { rows: [], columns: { id: [], v: [] } }],
    ] as const) {
      test(`a snapshot with ${provenance} provenance that rewrites no rows over a concurrent append reruns`, async () => {
        const { result } = await race(async ({ storage, dataset, concurrently }) => {
          const writes = (
            storage as unknown as {
              writes: { setCommitMetadata(...args: unknown[]): Promise<void> }
            }
          ).writes
          const setCommitMetadata = writes.setCommitMetadata.bind(writes)
          const spy = spyOn(writes, "setCommitMetadata").mockImplementation(async (...args) => {
            await concurrently()
            return setCommitMetadata(...args)
          })
          try {
            const write = await storage.beginWrite({
              dataset,
              producer: { kind: "pipeline", id: "seed", stepId: "copy" },
              lineage,
            })
            await write.writeRows([{ id: "1", v: "seed" }])
            const version = await write.commit()
            const rows = await collectRows(
              storage.readRows({ datasetId: dataset.id, versionId: version.versionId })
            )
            return { version, rows }
          } finally {
            spy.mockRestore()
          }
        })

        expect(result.rows).toEqual([{ id: "1", v: "seed" }])
        expect(result.version).toMatchObject({ outcome: "created", lineage })
      }, 60_000)
    }

    // Regression proof: in the write coordinator, read the latest version an unchanged snapshot
    // compares with through `getLatestVersionSummaryForDefinition`, without checking it against the
    // snapshot its rows were compared at. The append committed in between is then the version the
    // sync reports itself as, unchanged, and the dataset keeps a row the sync's source no longer has.
    test("a snapshot that rewrites no rows over an append committed after its comparison reruns", async () => {
      await twoWriters(async ({ storage, other, dataset }) => {
        const sync = { producer: { kind: "sync", id: "erp" } } as const
        await write(storage, dataset, sync, [{ id: "1", v: "seed" }])

        const session = await storage.beginWrite({ dataset, ...sync })
        await session.writeRows([{ id: "1", v: "seed" }])

        const restore = beforeUnchangedBaseline(storage, async () => {
          await write(other, dataset, { ...sync, mode: "append" }, [{ id: "2", v: "concurrent" }])
        })
        let version: DatasetWriteCommitResult
        try {
          version = await session.commit()
        } finally {
          restore()
        }

        expect(version.outcome).toBe("created")
        expect(
          await collectRows(
            storage.readRows({ datasetId: dataset.id, versionId: version.versionId })
          )
        ).toEqual([{ id: "1", v: "seed" }])
        expect(await collectRows(storage.readRows({ datasetId: dataset.id }))).toEqual([
          { id: "1", v: "seed" },
        ])
      })
    }, 60_000)
  })

  test("operates within a constrained PostgreSQL catalog connection budget", async () => {
    const catalogConnectionBudget = 4
    const rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-pg-budget-"))
    const roleName = `sixb_limited_${randomId()}`
    const password = `pw_${randomId()}`
    const metadataSchema = `sixb_${randomId()}`
    const applicationName = `sixb_budget_${randomId()}`
    const adminSql = createAdminSql()
    const dataset = defineDataset(`raw.pg.budget.${randomId()}`, {
      schema: [col("orderId", "string")],
    })
    const projectionDataset = defineDataset(`analytics.pg.budget.${randomId()}`, {
      schema: [col("orderId", "string")],
    })
    const catalog = postgresCatalog()
    if (catalog.type !== "postgres") {
      throw new Error("[SixbDuckLake] Expected PostgreSQL catalog test configuration.")
    }

    const storage = new DuckLakeStorage({
      catalog: {
        ...catalog,
        user: roleName,
        password,
        metadataSchema,
        applicationName,
      },
      dataPath: join(rootDir, "data"),
      duckdb: {
        config: {
          threads: "1",
        },
      },
      postgresPool: {
        maxConnections: catalogConnectionBudget,
        idleTimeoutMillis: 100,
        enableThreadLocalCache: false,
      },
    })
    let closeError: unknown

    try {
      await adminSql.unsafe(
        `CREATE ROLE ${quotePgIdent(roleName)} WITH LOGIN PASSWORD ${quotePgLiteral(
          password
        )} NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT ${catalogConnectionBudget}`
      )
      await adminSql.unsafe(
        `CREATE SCHEMA ${quotePgIdent(metadataSchema)} AUTHORIZATION ${quotePgIdent(roleName)}`
      )

      await expectCatalogConnectionsAtMost(adminSql, roleName, 0, "before first lake operation")
      await runBudgetStep("create dataset", () => storage.createDataset(dataset))
      await expectCatalogConnectionsAtMost(
        adminSql,
        roleName,
        catalogConnectionBudget,
        "after source dataset create"
      )
      await runBudgetStep("create projection dataset", () =>
        storage.createDataset(projectionDataset)
      )
      await expectCatalogConnectionsAtMost(
        adminSql,
        roleName,
        catalogConnectionBudget,
        "after projection dataset create"
      )

      const write = await runBudgetStep("begin snapshot write", () =>
        storage.beginWrite({ dataset, mode: "snapshot" })
      )
      await expectCatalogConnectionsAtMost(
        adminSql,
        roleName,
        catalogConnectionBudget,
        "after begin snapshot write"
      )
      await runBudgetStep("stage snapshot rows", () => write.writeRows([{ orderId: "ord_1" }]))
      await expectCatalogConnectionsAtMost(
        adminSql,
        roleName,
        catalogConnectionBudget,
        "after stage snapshot rows"
      )
      await runBudgetStep("commit snapshot write", () => write.commit())
      await expectCatalogConnectionsAtMost(
        adminSql,
        roleName,
        catalogConnectionBudget,
        "after commit snapshot write"
      )

      const append = await runBudgetStep("begin append write", () =>
        storage.beginWrite({ dataset, mode: "append" })
      )
      await expectCatalogConnectionsAtMost(
        adminSql,
        roleName,
        catalogConnectionBudget,
        "after begin append write"
      )
      await runBudgetStep("stage append rows", () => append.writeRows([{ orderId: "ord_2" }]))
      await expectCatalogConnectionsAtMost(
        adminSql,
        roleName,
        catalogConnectionBudget,
        "after stage append rows"
      )
      await runBudgetStep("commit append write", () => append.commit())
      await expectCatalogConnectionsAtMost(
        adminSql,
        roleName,
        catalogConnectionBudget,
        "after commit append write"
      )

      for (let index = 0; index < 10; index += 1) {
        await expect(
          runBudgetStep(`get dataset ${index}`, () => storage.getDataset(dataset.id))
        ).resolves.toMatchObject({ id: dataset.id })
        await expect(
          runBudgetStep(`get latest version ${index}`, () => storage.getLatestVersion(dataset.id))
        ).resolves.toMatchObject({
          datasetId: dataset.id,
        })
        await expectCatalogConnectionsAtMost(
          adminSql,
          roleName,
          catalogConnectionBudget,
          `after repeated metadata read ${index}`
        )
      }

      expect(
        await runBudgetStep("read rows", () =>
          collectRows(storage.readRows({ datasetId: dataset.id }))
        )
      ).toEqual([{ orderId: "ord_1" }, { orderId: "ord_2" }])
      await expectCatalogConnectionsAtMost(
        adminSql,
        roleName,
        catalogConnectionBudget,
        "after read rows"
      )

      const projected = await runBudgetStep("execute SQL transform", () =>
        storage.sql.execute({
          sources: {
            orders: { dataset },
          },
          target: projectionDataset,
          mode: "snapshot",
          producer: { kind: "pipeline", id: "projection" },
          sql: ({ orders }) => `SELECT orderId FROM ${orders} ORDER BY orderId`,
        })
      )
      await expectCatalogConnectionsAtMost(
        adminSql,
        roleName,
        catalogConnectionBudget,
        "after SQL transform commit"
      )
      const orderIdRef = { datasetId: dataset.id, column: "orderId" }
      expect(
        (
          await runBudgetStep("read SQL transform version", () =>
            storage.getVersion(projectionDataset.id, projected.versionId)
          )
        )?.lineage
      ).toEqual({ rows: [orderIdRef], columns: { orderId: [] } })
      expect(
        await runBudgetStep("read projected rows", () =>
          collectRows(storage.readRows({ datasetId: projectionDataset.id }))
        )
      ).toEqual([{ orderId: "ord_1" }, { orderId: "ord_2" }])
      await expectCatalogConnectionsAtMost(
        adminSql,
        roleName,
        catalogConnectionBudget,
        "after read projected rows"
      )

      const bulk = await storage.beginWrite({ dataset: projectionDataset, mode: "snapshot" })
      await bulk.writeRows(Array.from({ length: 20_003 }, (_, i) => ({ orderId: `bulk_${i}` })))
      await bulk.commit()
      const controller = new AbortController()
      // More inputs than both the default streaming cap and the role's connection limit.
      const readers = Array.from({ length: 6 }, () =>
        storage
          .readRows({ datasetId: projectionDataset.id, signal: controller.signal })
          [Symbol.asyncIterator]()
      )
      try {
        // Red check: admit every native reader regardless of the PostgreSQL pool budget.
        // Paused streams then exhaust the four-connection role and opening further readers times out.
        await runBudgetStep("open concurrent readers", () =>
          Promise.all(readers.map((r) => r.next()))
        )
        const concurrentWrite = await storage.beginWrite({ dataset, mode: "append" })
        await concurrentWrite.writeRows([{ orderId: "ord_3" }])
        await runBudgetStep("commit while readers are paused", () => concurrentWrite.commit())
        await expectCatalogConnectionsAtMost(
          adminSql,
          roleName,
          catalogConnectionBudget,
          "during concurrent reads and writes"
        )
      } finally {
        controller.abort()
        await Promise.all(readers.map((reader) => reader.return?.()))
      }
      expect(await collectRows(storage.readRows({ datasetId: dataset.id }))).toHaveLength(3)
    } finally {
      try {
        await storage.close()
        // The DuckDB PostgreSQL extension can retain one pool's worth of idle
        // backends after runtime close; the provider must not leave more than
        // the configured pool budget behind.
        await expectCatalogConnectionsAtMost(
          adminSql,
          roleName,
          catalogConnectionBudget,
          "after storage close"
        )
      } catch (error) {
        closeError = error
      }

      await terminateCatalogConnections(adminSql, roleName)
      await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${quotePgIdent(metadataSchema)} CASCADE`)
      await adminSql.unsafe(`DROP ROLE IF EXISTS ${quotePgIdent(roleName)}`)
      await adminSql.close()
      await rm(rootDir, { recursive: true, force: true })
    }

    if (closeError !== undefined) {
      throw closeError
    }
  }, 60_000)
})

describe("DuckLakeStorage automatic compaction on a PostgreSQL catalog", () => {
  const events = defineDataset(`raw.pg.events.${randomId()}`, {
    schema: [col("id", "string"), col("batch", "int64")],
  })
  const batch = (n: number) =>
    Array.from({ length: 20 }, (_, i) => ({ id: `b${n}_${i}`, batch: n }))

  async function append(storage: DuckLakeStorage, rows: readonly Record<string, unknown>[]) {
    const write = await storage.beginWrite({ dataset: events, mode: "append" })
    await write.writeRows(rows)
    return write.commit()
  }

  async function withLake(
    run: (options: DuckLakeStorageOptions, rootDir: string) => Promise<void>
  ): Promise<void> {
    const rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-pg-compaction-"))
    try {
      await run({ catalog: postgresCatalog(), dataPath: join(rootDir, "data") }, rootDir)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  }

  // Regression proof: make the write coordinator's versionCreated a no-op in DuckLakeStorage.
  // The 17 small files then stay.
  test("merges small files, and every version reads the rows it held", async () => {
    await withLake(async (options) => {
      let storage = new DuckLakeStorage(options)
      const versions: DatasetVersion[] = []

      try {
        await storage.createDataset(events)
        for (let n = 1; n <= 16; n++) {
          versions.push(await append(storage, batch(n)))
        }

        // A new provider checks its first commit, the 17th file; closing waits for the pass.
        await storage.close()
        storage = new DuckLakeStorage(options)
        versions.push(await append(storage, batch(17)))
        await storage.close()

        storage = new DuckLakeStorage(options)
        const [health] = await storage.maintenance.describeStorage([events.id])
        expect(health).toMatchObject({ dataFiles: 1, rowCount: 17 * 20 })

        for (const [index, version] of versions.entries()) {
          const rows = await collectRows(
            storage.readRows({ datasetId: events.id, versionId: version.versionId })
          )
          expect(rows.length).toBe((index + 1) * 20)
        }
      } finally {
        await storage.close()
      }
    })
  }, 60_000)

  // Regression proof: in readTableStorage, pass no inlined-delete tables to queryFiles. The
  // dataset then reads 100 rows but counts 110, and compaction leaves the seed file as it is.
  test("counts the deletes DuckLake keeps in the catalog, and rewrites the file they reach", async () => {
    await withLake(async (options) => {
      const scores = defineDataset(`crm.pg.scores.${randomId()}`, {
        schema: [col("id", "string"), col("score", "int64")],
        primaryKey: "id",
      })
      const adminSql = createAdminSql()
      let storage = new DuckLakeStorage(options)

      const merge = async (rows: readonly Record<string, unknown>[]) => {
        const session = await storage.beginMerge({ dataset: scores })
        await session.writeChanges(rows.map((row) => change.upsert(row)))
        await session.commit({ createInitialVersion: true })
      }
      const scored = (count: number, score: number) =>
        Array.from({ length: count }, (_, i) => ({ id: `a${i}`, score }))

      try {
        await storage.createDataset(scores)
        await merge(scored(100, 0))

        // Replacing ten rows of the seed file, DuckLake marks them deleted in the catalog.
        await merge(scored(10, 1))

        const [health] = await storage.maintenance.describeStorage([scores.id])
        expect(health).toMatchObject({ deleteFiles: 0, rowCount: 100 })
        expect(await collectRows(storage.readRows({ datasetId: scores.id }))).toHaveLength(100)

        // A new provider checks its first commit: an eleventh delete, over a tenth of the file.
        await storage.close()
        storage = new DuckLakeStorage(options)
        await merge([{ id: "a10", score: 2 }])
        await storage.close()

        storage = new DuckLakeStorage(options)
        const [settled] = await storage.maintenance.describeStorage([scores.id])
        expect(settled).toMatchObject({ deleteFiles: 0, rowCount: 100 })
        expect(await liveFileRows(adminSql, options, scores.id)).toEqual([89])
      } finally {
        await storage.close()
        await adminSql.close()
      }
    })
  }, 60_000)

  // Regression proof: in DuckLakeCompaction, take no lock in lockDataset. The write then commits
  // while the compaction waits to, and no write ever waits for the lock.
  test("a write in another process waits for a compaction to commit", async () => {
    await withLake(async (options) => {
      const writer = new DuckLakeStorage(options)
      let compactor: DuckLakeStorage | undefined
      const adminSql = createAdminSql()
      const warn = spyOn(console, "warn").mockImplementation(() => {})
      let release: (() => void) | undefined

      try {
        await writer.createDataset(events)
        for (let n = 1; n <= 16; n++) {
          await append(writer, batch(n))
        }

        // The compactor's merge is ready to commit when the writer replaces every row it merges.
        compactor = new DuckLakeStorage(options)
        const compaction = (
          compactor as unknown as {
            compaction: {
              plan(dataset: DatasetDefinition): Promise<unknown>
              commit(runtime: unknown, dataset: DatasetDefinition, retries: number): Promise<void>
            }
          }
        ).compaction
        const plan = spyOn(compaction, "plan")
        const commit = compaction.commit.bind(compaction)
        const committed: string[] = []
        let ready!: () => void
        const merged = new Promise<void>((resolve) => {
          ready = resolve
        })
        const released = new Promise<void>((resolve) => {
          release = resolve
        })
        spyOn(compaction, "commit").mockImplementation(async (runtime, dataset, retries) => {
          ready()
          await released
          await commit(runtime, dataset, retries)
          committed.push("compaction")
        })

        await append(compactor, batch(17))
        await merged

        const replace = await writer.beginWrite({ dataset: events, mode: "snapshot" })
        await replace.writeRows(batch(99))
        const replacing = replace.commit().then((version) => {
          committed.push("write")
          return version
        })

        await waitForDatasetLock(adminSql, options, events.id, {
          mode: "ShareLock",
          granted: false,
        })
        release?.()
        await compactor.close()
        const replaced = await replacing

        expect(committed).toEqual(["compaction", "write"])
        expect(warn).not.toHaveBeenCalled()
        expect(plan).toHaveBeenCalledTimes(1)
        expect((await writer.getLatestVersion(events.id))?.versionId).toBe(replaced.versionId)
        expect(await collectRows(writer.readRows({ datasetId: events.id }))).toEqual(
          batch(99).map((row) => ({ ...row, batch: "99" }))
        )
      } finally {
        // A failed check must not leave the compaction, and so the close, waiting.
        release?.()
        warn.mockRestore()
        await compactor?.close()
        await writer.close()
        await adminSql.close()
      }
    })
  }, 60_000)

  const accounts = defineDataset(`crm.pg.accounts.${randomId()}`, {
    schema: [col("id", "string"), col("batch", "int64")],
    primaryKey: "id",
  })

  /** 16 batches of rows, which `fillAccounts` appends as 16 small files. */
  const accountRows = (changed: boolean) =>
    Array.from({ length: 16 }, (_, index) => batch(index + 1))
      .flat()
      .map((row) =>
        changed && (row.id === "b1_3" || row.id === "b9_3") ? { ...row, batch: 100 } : row
      )

  async function fillAccounts(storage: DuckLakeStorage): Promise<void> {
    await storage.createDataset(accounts)
    for (let n = 1; n <= 16; n++) {
      const write = await storage.beginWrite({ dataset: accounts, mode: "append" })
      await write.writeRows(batch(n))
      await write.commit()
    }
  }

  function compactionOf(storage: DuckLakeStorage) {
    return (
      storage as unknown as {
        compaction: { afterCommit(dataset: DatasetDefinition): void; close(): Promise<void> }
      }
    ).compaction
  }

  /** Runs `during` once inside each commit's transaction, after its changes, before COMMIT. */
  function beforeCommit(storage: DuckLakeStorage, during: () => Promise<void>) {
    const writes = (
      storage as unknown as { writes: { setCommitMetadata(...args: unknown[]): Promise<void> } }
    ).writes
    const setCommitMetadata = writes.setCommitMetadata.bind(writes)

    return spyOn(writes, "setCommitMetadata").mockImplementation(async (...args) => {
      await during()
      return setCommitMetadata(...args)
    })
  }

  const sortedById = (rows: readonly Record<string, unknown>[]) =>
    [...rows].sort((left, right) => String(left.id).localeCompare(String(right.id)))

  // Regression proof: in beginDatasetTransaction, take no lock. The other process's compaction
  // then merges the 16 files while the write is open, the write still commits, and the two rows
  // it replaced read twice. DuckLake keeps the write's two deletes in the catalog, which is what
  // loses them (duckdb/ducklake#1484).
  test("a write open in one process keeps its deletes across another's compaction", async () => {
    await withLake(async (options) => {
      const writer = new DuckLakeStorage(options)
      const compactor = new DuckLakeStorage(options)
      const warn = spyOn(console, "warn").mockImplementation(() => {})

      try {
        await fillAccounts(writer)

        // The compaction runs, and finishes, while the write's transaction holds the lock.
        let filesWhileOpen: number | undefined
        beforeCommit(writer, async () => {
          if (filesWhileOpen !== undefined) {
            return
          }

          compactionOf(compactor).afterCommit(accounts)
          await compactionOf(compactor).close()

          const [health] = await compactor.maintenance.describeStorage([accounts.id])
          filesWhileOpen = health?.dataFiles
        })

        // A keyed snapshot that changes two rows deletes them, and inserts their new values.
        const write = await writer.beginWrite({ dataset: accounts, mode: "snapshot" })
        await write.writeRows(accountRows(true))
        const version = await write.commit()

        const expected = sortedById(
          accountRows(true).map((row) => ({ ...row, batch: String(row.batch) }))
        )
        expect((await writer.getLatestVersion(accounts.id))?.versionId).toBe(version.versionId)
        expect(sortedById(await collectRows(writer.readRows({ datasetId: accounts.id })))).toEqual(
          expected
        )

        // The compaction waited for the write, then yielded to it, as to a conflict.
        expect(filesWhileOpen).toBe(16)
        expect(warn).not.toHaveBeenCalled()

        // Once the write is done, the next compaction merges the files and keeps every row.
        const next = new DuckLakeStorage(options)
        try {
          compactionOf(next).afterCommit(accounts)
          await compactionOf(next).close()

          const [health] = await next.maintenance.describeStorage([accounts.id])
          expect(health?.dataFiles).toBeLessThan(16)
          expect(sortedById(await collectRows(next.readRows({ datasetId: accounts.id })))).toEqual(
            expected
          )
        } finally {
          await next.close()
        }
      } finally {
        warn.mockRestore()
        await compactor.close()
        await writer.close()
      }
    })
  }, 60_000)

  // Regression proof: in beginTransactionOnLatestVersion, take the lock after readLatestVersion.
  // The first read of the lake then finds no lock held. DuckDB commits a transaction's databases
  // in reverse order of first use, so a lock taken after it would end before DuckLake commits.
  test("a write holds its dataset's lock before it first reads the lake", async () => {
    await withLake(async (options) => {
      const writer = new DuckLakeStorage(options)
      const adminSql = createAdminSql()

      try {
        await fillAccounts(writer)

        const reader = (writer as unknown as { snapshotReader: DuckLakeSnapshotReader })
          .snapshotReader
        const readLatest = reader.getLatestVersionSummaryAtCurrentSnapshot.bind(reader)

        const locksAtFirstRead: unknown[] = []
        spyOn(reader, "getLatestVersionSummaryAtCurrentSnapshot").mockImplementation(
          async (...args) => {
            locksAtFirstRead.push(...(await datasetLocks(adminSql, options, accounts.id)))
            return readLatest(...args)
          }
        )

        const merge = await writer.beginMerge({ dataset: accounts })
        await merge.writeChanges([change.upsert({ id: "b1_3", batch: 100 })])
        await merge.commit()

        expect(locksAtFirstRead).toEqual([{ mode: "ShareLock", granted: true }])
      } finally {
        await adminSql.close()
        await writer.close()
      }
    })
  }, 60_000)
})

function postgresCatalog(): Extract<DuckLakeStorageOptions["catalog"], { type: "postgres" }> {
  return {
    type: "postgres",
    host: process.env.SIXB_DUCKLAKE_POSTGRES_HOST ?? "127.0.0.1",
    port: Number(process.env.SIXB_DUCKLAKE_POSTGRES_PORT ?? "54331"),
    database: process.env.SIXB_DUCKLAKE_POSTGRES_DATABASE ?? "postgres",
    user: process.env.SIXB_DUCKLAKE_POSTGRES_USER ?? "postgres",
    password: process.env.SIXB_DUCKLAKE_POSTGRES_PASSWORD ?? "test",
    metadataSchema: `sixb_${randomId()}`,
  }
}

function s3Secret(): DuckDbSecretOptions {
  return {
    type: "s3",
    keyId: process.env.SIXB_DUCKLAKE_S3_KEY_ID ?? "sixb",
    secret: process.env.SIXB_DUCKLAKE_S3_SECRET ?? "sixb-secret",
    region: "us-east-1",
    endpoint: process.env.SIXB_DUCKLAKE_S3_ENDPOINT ?? "127.0.0.1:19000",
    urlStyle: "path",
    useSsl: false,
    scope: `s3://${s3Bucket()}`,
  }
}

function s3Bucket(): string {
  return process.env.SIXB_DUCKLAKE_S3_BUCKET ?? "sixb-ducklake"
}

function randomId(): string {
  return randomUUID().replaceAll("-", "_")
}

function createAdminSql(): SQL {
  const url = new URL(
    `postgres://${process.env.SIXB_DUCKLAKE_POSTGRES_HOST ?? "127.0.0.1"}:${
      process.env.SIXB_DUCKLAKE_POSTGRES_PORT ?? "54331"
    }/${process.env.SIXB_DUCKLAKE_POSTGRES_DATABASE ?? "postgres"}`
  )
  url.username = process.env.SIXB_DUCKLAKE_POSTGRES_USER ?? "postgres"
  url.password = process.env.SIXB_DUCKLAKE_POSTGRES_PASSWORD ?? "test"

  return new SQL({ url: url.toString(), max: 1 })
}

interface DatasetLockRow {
  readonly mode: string
  readonly granted: boolean
}

/** The PostgreSQL advisory locks held on, or waited for, a dataset's lock key. */
async function datasetLocks(
  sql: SQL,
  options: DuckLakeStorageOptions,
  datasetId: string
): Promise<DatasetLockRow[]> {
  const { metadataSchema } = options.catalog as { readonly metadataSchema: string }
  const name = `sixb:${metadataSchema}:${encodeDatasetTableName(datasetId)}`

  // A bigint advisory key is stored as its high and low 32 bits.
  return (await sql.unsafe(
    `
      SELECT mode, granted FROM pg_locks
      WHERE locktype = 'advisory'
        AND objsubid = 1
        AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)
    `,
    [name]
  )) as DatasetLockRow[]
}

async function waitForDatasetLock(
  sql: SQL,
  options: DuckLakeStorageOptions,
  datasetId: string,
  lock: DatasetLockRow
): Promise<void> {
  const deadline = Date.now() + 10_000
  let locks: DatasetLockRow[] = []

  while (Date.now() < deadline) {
    locks = await datasetLocks(sql, options, datasetId)
    if (locks.some((row) => row.mode === lock.mode && row.granted === lock.granted)) {
      return
    }

    await sleep(20)
  }

  throw new Error(
    `[SixbDuckLake] Expected a ${lock.granted ? "granted" : "waiting"} ${lock.mode} on dataset '${datasetId}', found ${JSON.stringify(locks)}.`
  )
}

async function expectCatalogConnectionsAtMost(
  sql: SQL,
  roleName: string,
  maxConnections: number,
  step: string
): Promise<void> {
  const deadline = Date.now() + 5_000
  let connections: CatalogConnectionRow[] = []

  while (Date.now() < deadline) {
    connections = await catalogConnections(sql, roleName)
    if (connections.length <= maxConnections) {
      expect(connections.length).toBeLessThanOrEqual(maxConnections)
      return
    }

    await sleep(50)
  }

  throw new Error(
    `[SixbDuckLake] Expected at most ${maxConnections} PostgreSQL catalog connection(s) for role '${roleName}' ${step}, found ${connections.length}: ${JSON.stringify(
      connections
    )}`
  )
}

interface CatalogConnectionRow {
  readonly application_name: string
  readonly state: string | null
  readonly wait_event_type: string | null
  readonly wait_event: string | null
  readonly query: string
}

async function catalogConnections(sql: SQL, roleName: string): Promise<CatalogConnectionRow[]> {
  return (await sql.unsafe(
    `
      SELECT application_name, state, wait_event_type, wait_event, query
      FROM pg_stat_activity
      WHERE usename = $1
      ORDER BY application_name, state, wait_event_type, wait_event, query
    `,
    [roleName]
  )) as CatalogConnectionRow[]
}

async function terminateCatalogConnections(sql: SQL, roleName: string): Promise<void> {
  await sql.unsafe("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1", [
    roleName,
  ])
}

async function runBudgetStep<T>(step: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `[SixbDuckLake] Constrained connection budget test failed during ${step}: ${message}`
    )
  }
}

/** The rows each live data file of the dataset was written with, deleted ones included. */
async function liveFileRows(
  sql: SQL,
  options: DuckLakeStorageOptions,
  datasetId: string
): Promise<number[]> {
  const { metadataSchema } = options.catalog as { readonly metadataSchema: string }
  const table = (name: string) => `${quotePgIdent(metadataSchema)}.${quotePgIdent(name)}`

  const files = await sql.unsafe(`
    SELECT file.record_count
    FROM ${table("ducklake_data_file")} file
    JOIN ${table("ducklake_table")} t ON t.table_id = file.table_id
    WHERE file.end_snapshot IS NULL AND t.end_snapshot IS NULL
      AND t.table_name = ${quotePgLiteral(encodeDatasetTableName(datasetId))}
    ORDER BY file.data_file_id
  `)

  return files.map((file: { readonly record_count: unknown }) => Number(file.record_count))
}

/** Appends Sixb commits to one dataset, as inline DuckLake inserts, after the latest snapshot. */
async function appendPostgresHistory(
  sql: SQL,
  metadataSchema: string,
  datasetId: string,
  length: number
): Promise<void> {
  const table = (name: string) => `${quotePgIdent(metadataSchema)}.${quotePgIdent(name)}`
  const [busyTable] = await sql.unsafe(
    `SELECT table_id FROM ${table("ducklake_table")}
     WHERE table_name = ${quotePgLiteral(encodeDatasetTableName(datasetId))} AND end_snapshot IS NULL`
  )
  await sql.unsafe(`
    INSERT INTO ${table("ducklake_snapshot")}
      (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id)
    SELECT
      latest.snapshot_id + offsets.n,
      latest.snapshot_time + offsets.n * interval '1 second',
      latest.schema_version,
      latest.next_catalog_id,
      latest.next_file_id
    FROM (SELECT * FROM ${table("ducklake_snapshot")} ORDER BY snapshot_id DESC LIMIT 1) latest,
      generate_series(1, ${length}) AS offsets(n)
  `)
  await sql.unsafe(`
    INSERT INTO ${table("ducklake_snapshot_changes")}
      (snapshot_id, changes_made, author, commit_message, commit_extra_info)
    SELECT
      snapshot.snapshot_id,
      ${quotePgLiteral(`inlined_insert:${busyTable?.table_id}`)},
      'Sixb',
      'history',
      ${quotePgLiteral(`{"sixb":{"kind":"datasetVersion","datasetId":${JSON.stringify(datasetId)},"mode":"append","commitId":"history-`)}
        || snapshot.snapshot_id || '"}}'
    FROM ${table("ducklake_snapshot")} snapshot
    LEFT JOIN ${table("ducklake_snapshot_changes")} changes USING (snapshot_id)
    WHERE changes.snapshot_id IS NULL
  `)
}

/**
 * Rows PostgreSQL reads to run the catalog queries DuckDB sent it through `postgres_query`: each
 * scan's returned and filtered-out rows, from EXPLAIN ANALYZE.
 */
async function rowsReadByPostgres(sql: SQL, duckDbQueries: readonly string[]): Promise<number> {
  let rows = 0

  for (const duckDbQuery of duckDbQueries) {
    const pushedDown = /postgres_query\('[^']*', '([\s\S]*)'\)\s*$/.exec(duckDbQuery.trim())?.[1]
    if (pushedDown === undefined) {
      continue
    }

    const [explained] = await sql.unsafe(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${pushedDown.replaceAll("''", "'")}`
    )
    rows += scannedRows(explained["QUERY PLAN"][0].Plan)
  }

  return rows
}

interface PlanNode {
  readonly "Relation Name"?: string
  readonly "Actual Rows": number
  readonly "Actual Loops": number
  readonly "Rows Removed by Filter"?: number
  readonly Plans?: readonly PlanNode[]
}

function scannedRows(node: PlanNode): number {
  const own =
    node["Relation Name"] === undefined
      ? 0
      : (node["Actual Rows"] + (node["Rows Removed by Filter"] ?? 0)) * node["Actual Loops"]

  return own + (node.Plans ?? []).reduce((sum, child) => sum + scannedRows(child), 0)
}

function quotePgIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function quotePgLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}
