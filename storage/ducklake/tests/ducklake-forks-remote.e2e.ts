import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DuckDBInstance } from "@duckdb/node-api"
import { change, col, defineDataset } from "@sixb/core"
import { runLakeForksContractSuite } from "@sixb/core/testing"
import { DuckLakeStorage, type DuckLakeStorageOptions } from "../src"
import { collectRows } from "./test-utils"

// A PostgreSQL catalog keeps rows inlined in the catalog encoded (strings as bytea, timestamps as
// text): the slice must decode them as DuckLake does. Files on S3 are served through production.
const roots = new WeakMap<DuckLakeStorage, string>()

for (const data of ["local", "s3"] as const) {
  runLakeForksContractSuite(`DuckLakeStorage postgres catalog, ${data} files, forks contract`, {
    async createStorage() {
      const rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-forks-remote-"))
      const storage = new DuckLakeStorage(productionOptions(rootDir, data))
      roots.set(storage, rootDir)
      return storage
    },
    async teardown(storage) {
      await storage.close()
      const rootDir = roots.get(storage)
      if (rootDir) await rm(rootDir, { recursive: true, force: true })
    },
    openBranch: ({ slicePath, filesUrl, token, directory }) =>
      new DuckLakeStorage({
        catalog: { type: "duckdb", path: slicePath },
        dataPath: join(directory, "data"),
        productionFiles: { url: filesUrl, token, cacheDirectory: join(directory, "cache") },
      }),
  })
}

function productionOptions(
  rootDir: string,
  data: "local" | "s3",
  endpoint = process.env.SIXB_DUCKLAKE_S3_ENDPOINT ?? "127.0.0.1:19000"
): DuckLakeStorageOptions {
  const id = randomUUID().replaceAll("-", "_")
  const bucket = process.env.SIXB_DUCKLAKE_S3_BUCKET ?? "sixb-ducklake"

  return {
    catalog: {
      type: "postgres",
      host: process.env.SIXB_DUCKLAKE_POSTGRES_HOST ?? "127.0.0.1",
      port: Number(process.env.SIXB_DUCKLAKE_POSTGRES_PORT ?? "54331"),
      database: process.env.SIXB_DUCKLAKE_POSTGRES_DATABASE ?? "postgres",
      user: process.env.SIXB_DUCKLAKE_POSTGRES_USER ?? "postgres",
      password: process.env.SIXB_DUCKLAKE_POSTGRES_PASSWORD ?? "test",
      metadataSchema: `sixb_forks_${id}`,
    },
    ...(data === "local"
      ? { dataPath: join(rootDir, "data") }
      : {
          dataPath: `s3://${bucket}/forks-${id}/`,
          secrets: [
            {
              type: "s3",
              keyId: process.env.SIXB_DUCKLAKE_S3_KEY_ID ?? "sixb",
              secret: process.env.SIXB_DUCKLAKE_S3_SECRET ?? "sixb-secret",
              region: "us-east-1",
              endpoint,
              urlStyle: "path",
              useSsl: false,
              scope: `s3://${bucket}`,
            },
          ],
        }),
  }
}

describe("DuckLakeStorage postgres catalog, a cut beside another process", () => {
  // The cut's own catalog reads are one transaction; DuckLake reads the version through its own
  // connections. Another process expiring the version mid-cut makes the cut refuse, cleanly.
  // Red check: in writeCatalogSlice, rethrow the error as it is, or skip removing the file.
  test("refuses, keeping nothing, when another process expires the version mid-cut", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-forks-race-"))
    // Production's bucket, reached through a gate that holds the cut's first request to it: the
    // cut is then inside its transaction, and another process changes the catalog meanwhile.
    const gate = await openGate(process.env.SIXB_DUCKLAKE_S3_ENDPOINT ?? "127.0.0.1:19000")
    const options = productionOptions(rootDir, "s3", `127.0.0.1:${gate.port}`)
    const production = new DuckLakeStorage(options)
    const people = defineDataset("race.people", {
      schema: [col("id", "string"), col("salary", "float64")],
      primaryKey: "id",
    })
    try {
      await production.createDataset(people)
      const write = await production.beginWrite({ dataset: people, mode: "snapshot" })
      await write.writeRows(
        Array.from({ length: 20_000 }, (_, index) => ({ id: `p-${index}`, salary: index }))
      )
      await write.commit()
      for (const changes of [
        [change.delete({ id: "p-3" })],
        [change.upsert({ id: "p-new-1", salary: 1 }), change.upsert({ id: "p-new-2", salary: 2 })],
      ]) {
        const merge = await production.beginMerge({ dataset: people })
        await merge.writeChanges(changes)
        await merge.commit()
      }

      const point = await production.forks.currentPoint()
      const at = await production.forks.versionsAt({ point, datasetIds: [people.id] })
      const version = { datasetId: people.id, versionId: `${at.get(people.id)?.versionId}` }
      // A later commit: DuckLake never expires the catalog's newest snapshot.
      const later = defineDataset("race.later", { schema: [col("id", "string")] })
      await production.createDataset(later)

      const slicePath = join(rootDir, "slice.ducklake")
      const held = gate.holdNext()
      const cut = production.forks.writeSlice({
        point,
        versions: [version],
        path: slicePath,
        record: async () => undefined,
      })
      await held
      await maintainElsewhere(options, version.versionId.slice("ducklake:".length))
      gate.release()
      const outcome = await cut.then(
        () => null,
        (error: unknown) => error
      )

      expect(String(outcome)).toContain("[SixbDuckLake] The slice could not be cut")
      expect(String(outcome)).toContain("Cut the slice again")
      expect(await Bun.file(slicePath).exists()).toBe(false)

      // Cut again, at a version production still has, it holds exactly that version's rows.
      const now = await production.forks.currentPoint()
      const again = await production.forks.versionsAt({ point: now, datasetIds: [people.id] })
      const current = { datasetId: people.id, versionId: `${again.get(people.id)?.versionId}` }
      await production.forks.writeSlice({
        point: now,
        versions: [current],
        path: slicePath,
        record: async () => undefined,
      })
      expect(await sliceRows(slicePath)).toBe(
        (await collectRows(production.readRows(current))).length
      )
    } finally {
      gate.close()
      await production.close()
      await rm(rootDir, { recursive: true, force: true })
    }
  }, 60_000)
})

/** Rows the slice holds, from its catalog alone: its files' record counts and its inlined rows. */
async function sliceRows(slicePath: string): Promise<number> {
  const instance = await DuckDBInstance.create(":memory:")
  const connection = await instance.connect()
  try {
    await connection.run(`ATTACH '${slicePath}' AS slice (READ_ONLY)`)
    const read = async (sql: string) =>
      Number((await connection.runAndReadAll(sql)).getRowObjectsJson()[0]?.rows ?? 0)
    let rows = await read(
      "SELECT coalesce(sum(record_count), 0) AS rows FROM slice.ducklake_data_file"
    )
    const inlined = (
      await connection.runAndReadAll("SELECT table_name FROM slice.ducklake_inlined_data_tables")
    ).getRowObjectsJson()
    for (const { table_name } of inlined) {
      rows += await read(`SELECT count(*) AS rows FROM slice."${table_name}"`)
    }
    return rows
  } finally {
    connection.closeSync()
    instance.closeSync()
  }
}

/** A TCP gate in front of the bucket that can hold the next connection until released. */
async function openGate(target: string) {
  const [host, port] = target.split(":")
  let holding: (() => void) | undefined
  const opened: Promise<void> = Promise.resolve()
  let release: () => void = () => undefined
  const server = Bun.listen<{
    upstream?: Awaited<ReturnType<typeof Bun.connect>>
    buffered: Uint8Array[]
  }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      async open(socket) {
        socket.data = { buffered: [] }
        if (holding) {
          const held = holding
          holding = undefined
          const released = new Promise<void>((resolve) => {
            release = resolve
          })
          held()
          await released
        }
        await opened
        socket.data.upstream = await Bun.connect({
          hostname: host as string,
          port: Number(port),
          socket: {
            data: (_upstream, chunk) => {
              socket.write(chunk)
            },
            close: () => {
              socket.end()
            },
          },
        })
        for (const chunk of socket.data.buffered) socket.data.upstream.write(chunk)
        socket.data.buffered = []
      },
      data(socket, chunk) {
        if (socket.data.upstream) socket.data.upstream.write(chunk)
        else socket.data.buffered.push(new Uint8Array(chunk))
      },
      close(socket) {
        socket.data.upstream?.end()
      },
    },
  })
  return {
    port: server.port,
    holdNext: () =>
      new Promise<void>((resolve) => {
        holding = resolve
      }),
    release: () => release(),
    close: () => server.stop(true),
  }
}

/** Another process's maintenance of the catalog: it expires the version being cut, and flushes. */
async function maintainElsewhere(options: DuckLakeStorageOptions, snapshotId: string) {
  const catalog = options.catalog as Extract<
    DuckLakeStorageOptions["catalog"],
    { type: "postgres" }
  >
  const instance = await DuckDBInstance.create(":memory:")
  const connection = await instance.connect()
  try {
    await connection.run("LOAD ducklake; LOAD postgres")
    await connection.run(
      `ATTACH 'ducklake:postgres:host=${catalog.host} port=${catalog.port} dbname=${catalog.database} user=${catalog.user} password=${catalog.password}' AS other (METADATA_SCHEMA '${catalog.metadataSchema}')`
    )
    await connection.run(`CALL ducklake_expire_snapshots('other', versions => [${snapshotId}])`)
  } finally {
    connection.closeSync()
    instance.closeSync()
  }
}
