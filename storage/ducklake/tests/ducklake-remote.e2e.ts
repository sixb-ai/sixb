import { describe, expect, spyOn, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { change, col, type DatasetDefinition, defineDataset } from "@sixb/core"
import type { DatasetVersion } from "@sixb/core/lake-storage"
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
        schema: [col("id", "string"), col("revision", "int64")],
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
        await seed.writeChanges([change.upsert({ id: "42", revision: 7 })])
        await seed.commit()
      }
      const children = [
        [change.upsert({ id: "42", revision: 8 })],
        scenario === "deletion"
          ? [change.delete({ id: "42" }, { sequence: 9 })]
          : [change.upsert({ id: scenario === "different keys" ? "other" : "42", revision: 9 })],
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
        else expect(rows).toEqual(scenario === "deletion" ? [] : [{ id: "42", revision: "9" }])
      } finally {
        for (const child of children) child.process.kill()
        await Promise.all(children.map((child) => child.finished))
        await storage.close()
        await rm(rootDir, { recursive: true, force: true })
      }
    }, 40_000)
  test("uses a PostgreSQL catalog with a local data path", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-pg-local-"))
    const dataset = defineDataset(`raw.pg.local.${randomId()}`, {
      schema: [col("orderId", "string")],
      primaryKey: "orderId",
    })
    const storage = new DuckLakeStorage({
      catalog: postgresCatalog(),
      dataPath: join(rootDir, "data"),
    })

    try {
      await storage.createDataset(dataset)
      await expect(storage.getDataset(dataset.id)).resolves.toEqual(dataset)
      const write = await storage.beginWrite({ dataset, mode: "snapshot" })
      await write.writeRows([{ orderId: "ord_1" }])
      await write.commit()

      const append = await storage.beginWrite({ dataset, mode: "append" })
      await append.writeRows([{ orderId: "ord_2" }])
      const appendVersion = await append.commit()

      const merge = await storage.beginMerge({ dataset })
      await merge.writeChanges([
        change.delete({ orderId: "ord_1" }),
        change.upsert({ orderId: "ord_3" }),
      ])
      const mergeResult = await merge.commit()

      expect(mergeResult).toMatchObject({
        outcome: "created",
        version: {
          mode: "merge",
          parentVersionId: appendVersion.versionId,
          rowCount: 2,
        },
      })

      expect(await collectRows(storage.readRows({ datasetId: dataset.id }))).toEqual([
        { orderId: "ord_2" },
        { orderId: "ord_3" },
      ])
    } finally {
      await storage.close()
      await rm(rootDir, { recursive: true, force: true })
    }
  })

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

  test("does not exhaust the PostgreSQL catalog pool across repeated metadata reads", async () => {
    const dataset = defineDataset(`raw.pg.metadata.${randomId()}`, {
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
    const rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-pg-shared-"))
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

function quotePgIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function quotePgLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}
