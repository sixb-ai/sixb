import { describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { col, defineDataset } from "@sixb/core"
import { DuckLakeStorage, type DuckLakeStorageOptions } from "../src"
import type { DuckLakeConnectionManager } from "../src/internal/ducklake-connection-manager"
import { collectRows } from "./test-utils"

const dataset = defineDataset("reader.synthetic", {
  schema: [col("id", "string"), col("value", "int64")],
})
const rowCount = 12_003

// Red check: restore ducklake-row-reader.ts from the parent commit. The consumer metadata/write
// tests time out because the previous paged iterator holds its attachment lease across yields.
describe("DuckLake reader lifecycle", () => {
  test("cancels a paused paged reader without waiting for its consumer", async () => {
    await withLake({}, async (lake) => {
      await seed(lake)
      const controller = new AbortController()
      const paused = lake
        .readRows({ datasetId: dataset.id, limit: 2, signal: controller.signal })
        [Symbol.asyncIterator]()
      try {
        await paused.next()
        // Red check: remove the paged reader's abort listener. Maintenance then waits forever.
        controller.abort(new Error("cancel paged read"))
        await bounded(lake.runMaintenance({ dryRun: true }))
        await expect(paused.next()).rejects.toThrow("cancel paged read")
      } finally {
        await paused.return?.()
      }
    })
  })

  test("can evolve the schema while a reader retains its original version", async () => {
    await withLake({}, async (lake) => {
      await seed(lake)
      const rows = lake.readRows({ datasetId: dataset.id })[Symbol.asyncIterator]()
      try {
        await rows.next()
        const evolved = defineDataset(dataset.id, {
          schema: [...dataset.schema.columns, col("extra", "string", { nullable: true })],
        })
        // Red check: refresh immediately while a reader pins the catalog. The DDL commits but
        // createDataset either rejects afterward or detaches the active reader's catalog.
        expect(await bounded(lake.createDataset(evolved))).toEqual(evolved)
        let count = 1
        for (let row = await rows.next(); !row.done; row = await rows.next()) {
          expect(row.value).not.toHaveProperty("extra")
          count++
        }
        expect(count).toBe(rowCount)
        expect(await lake.getDataset(dataset.id)).toEqual(evolved)
      } finally {
        await rows.return?.()
      }
    })
  })

  for (const catalog of ["duckdb", "sqlite"] as const) {
    test(`${catalog}: consumer can query metadata and commit writes while its source stays pinned`, async () => {
      await withLake({ catalog }, async (lake) => {
        const version = await seed(lake)
        const rows = lake.readRows({ datasetId: dataset.id })[Symbol.asyncIterator]()
        try {
          const first = await rows.next()
          expect(first.done).toBe(false)
          expect(await bounded(lake.getLatestVersion(dataset.id))).toMatchObject({
            versionId: version.versionId,
          })
          const writer = await bounded(lake.beginWrite({ dataset, mode: "append" }))
          await bounded(writer.writeRows([{ id: "new", value: 42 }]))
          // Red check: restore the parent's write coordinator. SQLite fails at COMMIT because
          // its direct metadata read holds a lock inside the DuckLake write transaction.
          const next = await bounded(writer.commit())
          expect(next.versionId).not.toBe(version.versionId)
          const ids = new Set([first.value?.id])
          for (let row = await rows.next(); !row.done; row = await rows.next())
            ids.add(row.value.id)
          expect(ids.size).toBe(rowCount)
          expect(ids.has("new")).toBe(false)
          expect((await collectRows(lake.readRows({ datasetId: dataset.id }))).length).toBe(
            rowCount + 1
          )
        } finally {
          await rows.return?.()
        }
      })
    })
  }

  for (const maxStreamingReads of [undefined, 1, 8]) {
    test(`pages excess inputs without exceeding the streaming limit (${maxStreamingReads ?? "default"})`, async () => {
      await withLake({ maxStreamingReads }, async (lake) => {
        await seed(lake)
        const limit = maxStreamingReads ?? 4
        const controller = new AbortController()
        const readers = Array.from({ length: limit + 2 }, () =>
          lake
            .readRows({ datasetId: dataset.id, signal: controller.signal })
            [Symbol.asyncIterator]()
        )
        const runtime = await connectionsFor(lake).runtime()
        const streams = spyOn(runtime, "openReader")
        try {
          // Red check: restore the strict read gate. Waiting for every input then times out.
          // Removing the native cap instead starts more streaming connections than allowed.
          const first = await bounded(Promise.all(readers.map((reader) => reader.next())))
          expect(first.every((row) => !row.done)).toBe(true)
          expect(streams).toHaveBeenCalledTimes(limit)
          const append = await lake.beginWrite({ dataset, mode: "append" })
          await append.writeRows([{ id: "new", value: 42 }])
          await append.commit()
          let expected: unknown[] | undefined
          for (const [index, reader] of readers.entries()) {
            const ids = [first[index]!.value!.id]
            for (let row = await reader.next(); !row.done; row = await reader.next())
              ids.push(row.value.id)
            expect(ids).toHaveLength(rowCount)
            expect(new Set(ids).size).toBe(rowCount)
            expect(ids).not.toContain("new")
            if (expected) expect(ids).toEqual(expected)
            else expected = ids
          }
        } finally {
          controller.abort()
          await Promise.allSettled(readers.map((reader) => reader.return?.()))
          streams.mockRestore()
        }
      })
    })
  }

  test("reuses a streaming slot after abort without waiting for the consumer", async () => {
    await withLake({ maxStreamingReads: 1 }, async (lake) => {
      await seed(lake)
      const active = new AbortController()
      const first = lake
        .readRows({ datasetId: dataset.id, signal: active.signal })
        [Symbol.asyncIterator]()
      const second = lake.readRows({ datasetId: dataset.id })[Symbol.asyncIterator]()
      const streams = spyOn(await connectionsFor(lake).runtime(), "openReader")
      try {
        await first.next()
        active.abort(new Error("cancel active reader"))
        // Cancellation must finish cleanup even while the consumer retains the paused iterator.
        await bounded(lake.runMaintenance({ dryRun: true }))
        expect((await bounded(second.next())).done).toBe(false)
        expect(streams).toHaveBeenCalledTimes(2)
        await expect(first.next()).rejects.toThrow("cancel active reader")
      } finally {
        active.abort()
        await first.return?.()
        await second.return?.()
        streams.mockRestore()
      }
    })
  })

  test("early return releases the local catalog immediately, including on reopen", async () => {
    await withLake({}, async (lake, options) => {
      await seed(lake)
      for await (const _row of lake.readRows({ datasetId: dataset.id })) break
      const peer = new DuckLakeStorage(options)
      try {
        expect((await bounded(collectRows(peer.readRows({ datasetId: dataset.id })))).length).toBe(
          rowCount
        )
      } finally {
        await peer.close()
      }
    })
  })

  test("close stops native, paged, and starting reads and releases the catalog", async () => {
    await withLake({ maxStreamingReads: 1 }, async (lake, options) => {
      await seed(lake)
      const first = lake.readRows({ datasetId: dataset.id })[Symbol.asyncIterator]()
      const second = lake.readRows({ datasetId: dataset.id })[Symbol.asyncIterator]()
      const third = lake.readRows({ datasetId: dataset.id })[Symbol.asyncIterator]()
      try {
        await first.next()
        await second.next()
        const pending = third.next()
        const rejected = pending.catch((error: unknown) => error)
        await bounded(lake.close())
        expect(await rejected).toMatchObject({
          message: "[SixbDuckLake] DuckLakeStorage is closed.",
        })
        await expect(first.next()).rejects.toThrow("closed")
        await expect(second.next()).rejects.toThrow("closed")
        const peer = new DuckLakeStorage(options)
        try {
          expect(
            (await bounded(collectRows(peer.readRows({ datasetId: dataset.id })))).length
          ).toBe(rowCount)
        } finally {
          await peer.close()
        }
      } finally {
        await first.return?.()
        await second.return?.()
        await third.return?.()
      }
    })
  })

  test("waiting maintenance allows nested inputs and waits for paged readers too", async () => {
    await withLake({ maxStreamingReads: 1 }, async (lake) => {
      await seed(lake)
      const controller = new AbortController()
      const rows = lake
        .readRows({ datasetId: dataset.id, signal: controller.signal })
        [Symbol.asyncIterator]()
      const nested = lake
        .readRows({ datasetId: dataset.id, signal: controller.signal })
        [Symbol.asyncIterator]()
      let maintenance: Promise<unknown> | undefined
      try {
        await rows.next()
        let finished = false
        maintenance = lake.runMaintenance({ expireOlderThan: "0 seconds" }).then(() => {
          finished = true
        })
        await Bun.sleep(20)
        expect(finished).toBe(false)
        expect(await bounded(lake.getLatestVersion(dataset.id))).not.toBeNull()
        // Red check: block admissions as soon as maintenance is requested. The nested input
        // then waits for maintenance, which waits for the first input to finish: a circular wait.
        expect((await bounded(nested.next())).done).toBe(false)
        await rows.return?.()
        await Bun.sleep(20)
        expect(finished).toBe(false)
        let count = 1
        for (let row = await nested.next(); !row.done; row = await nested.next()) count++
        expect(count).toBe(rowCount)
        await bounded(maintenance)
      } finally {
        controller.abort()
        await Promise.allSettled([rows.return?.(), nested.return?.()])
        await maintenance
      }
    })
  })
})

async function seed(lake: DuckLakeStorage) {
  await lake.createDataset(dataset)
  const writer = await lake.beginWrite({ dataset, mode: "snapshot" })
  await writer.writeRows(
    (async function* () {
      for (let id = 0; id < rowCount; id++) yield { id: String(id), value: id }
    })()
  )
  return writer.commit()
}

async function withLake(
  input: { readonly catalog?: "duckdb" | "sqlite"; readonly maxStreamingReads?: number },
  run: (lake: DuckLakeStorage, options: DuckLakeStorageOptions) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "sixb-reader-e2e-"))
  const options: DuckLakeStorageOptions = {
    catalog: { type: input.catalog ?? "duckdb", path: join(root, "catalog.db") },
    dataPath: join(root, "data"),
    duckdb: { config: { threads: "2", memory_limit: "256MB" } },
    maxStreamingReads: input.maxStreamingReads,
  }
  const lake = new DuckLakeStorage(options)
  try {
    await run(lake, options)
  } finally {
    await lake.close()
    await rm(root, { recursive: true, force: true })
  }
}

function connectionsFor(lake: DuckLakeStorage): DuckLakeConnectionManager {
  return (lake as unknown as { readonly connections: DuckLakeConnectionManager }).connections
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: Timer | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("reader operation timed out")), 2_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
