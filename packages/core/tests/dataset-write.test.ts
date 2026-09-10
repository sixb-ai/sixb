import { describe, expect, test } from "bun:test"
import { InMemoryBlobStorage } from "../src/blob-storage"
import { change, col, defineDataset } from "../src/datasets"
import { writeDataset } from "../src/datasets/write"
import {
  type BeginDatasetMergeInput,
  type BeginDatasetWriteInput,
  type DatasetRow,
  InMemoryLakeStorage,
} from "../src/lake-storage"

const people = defineDataset("people", {
  schema: [col("id", "string"), col("name", "string")],
  primaryKey: "id",
})

class ObservedLake extends InMemoryLakeStorage {
  aborts = 0
  failAbort = false

  override async beginWrite(input: BeginDatasetWriteInput) {
    return this.observe(await super.beginWrite(input))
  }

  override async beginMerge(input: BeginDatasetMergeInput) {
    return this.observe(await super.beginMerge(input))
  }

  private observe<T extends { abort(): Promise<void> }>(session: T): T {
    const abort = session.abort.bind(session)
    session.abort = async () => {
      this.aborts += 1
      await abort()
      if (this.failAbort) throw new Error("cleanup failed")
    }
    return session
  }
}

async function rows(lake: InMemoryLakeStorage): Promise<DatasetRow[]> {
  const result: DatasetRow[] = []
  for await (const row of lake.readRows({ datasetId: people.id })) result.push(row)
  return result
}

describe("shared dataset writer", () => {
  test("writes snapshots, appends, and merges without a sync execution", async () => {
    const lakeStorage = new InMemoryLakeStorage()
    const common = {
      lakeStorage,
      blobStorage: new InMemoryBlobStorage(),
      dataset: people,
      signal: new AbortController().signal,
    }
    const first = await writeDataset({
      ...common,
      mode: "snapshot",
      readValues: async () => [{ value: { id: "1", name: "Sam" } }],
    })
    expect(first).toMatchObject({ outcome: "created", rowsRead: 1, version: { rowCount: 1 } })
    await writeDataset({
      ...common,
      mode: "append",
      readValues: async () => [{ value: { id: "2", name: "Alex" } }],
    })
    const merged = await writeDataset({
      ...common,
      mode: "merge",
      readValues: async () => [
        { value: change.upsert({ id: "1", name: "Samuel" }) },
        { value: change.delete({ id: "2" }) },
      ],
    })
    expect(merged).toMatchObject({ outcome: "created", rowsRead: 2, version: { rowCount: 1 } })
    expect(await rows(lakeStorage)).toEqual([{ id: "1", name: "Samuel" }])
    const identical = await writeDataset({
      ...common,
      mode: "snapshot",
      readValues: async () => [{ value: { id: "1", name: "Samuel" } }],
    })
    expect(identical).toMatchObject({
      outcome: "unchanged",
      version: { versionId: merged.version?.versionId },
    })
  })

  test("empty append and merge reuse no version; an empty snapshot is addressable", async () => {
    // Regression proof: remove the empty-append branch in writeDataset; the first assertion fails.
    const lakeStorage = new InMemoryLakeStorage()
    const common = {
      lakeStorage,
      blobStorage: new InMemoryBlobStorage(),
      dataset: people,
      signal: new AbortController().signal,
      readValues: async () => [],
    }
    for (const mode of ["append", "merge"] as const) {
      expect(await writeDataset({ ...common, mode })).toEqual({
        outcome: "unchanged",
        rowsRead: 0,
        version: null,
      })
    }
    const snapshot = await writeDataset({ ...common, mode: "snapshot" })
    expect(snapshot).toMatchObject({ outcome: "created", rowsRead: 0, version: { rowCount: 0 } })
    const append = await writeDataset({ ...common, mode: "append" })
    expect(append).toMatchObject({
      outcome: "unchanged",
      version: { versionId: snapshot.version?.versionId },
    })
  })

  for (const mode of ["snapshot", "merge"] as const) {
    test(`${mode} validation preserves caller provenance and closes failed streams/sessions`, async () => {
      // Regression proof: remove abortWrite from the catch path; the abort-count assertion fails.
      const lakeStorage = new ObservedLake()
      lakeStorage.failAbort = true
      let read = 0
      let closed = false
      const failure = new Error("invalid record from account A")
      const value = (row: object) => (mode === "merge" ? change.upsert(row) : row)
      await expect(
        writeDataset({
          lakeStorage,
          blobStorage: new InMemoryBlobStorage(),
          dataset: people,
          mode,
          signal: new AbortController().signal,
          readValues: async () =>
            (async function* () {
              try {
                yield { value: value({ id: "1", name: "Sam" }), account: "A" }
                yield { value: value({ id: "2" }), account: "A" }
                throw new Error("must stop before requesting another value")
              } finally {
                closed = true
              }
            })(),
          onRead(count) {
            read = count
          },
          mapValidationError(error, item, index) {
            expect(error).toBeInstanceOf(Error)
            expect(item.account).toBe("A")
            expect(index).toBe(2)
            return failure
          },
        })
      ).rejects.toBe(failure)
      expect(read).toBe(1)
      expect(closed).toBe(true)
      expect(lakeStorage.aborts).toBe(1)
      expect(await lakeStorage.getLatestVersion(people.id)).toBeNull()
    })

    test(`${mode} cancellation aborts staged rows and preserves the prior version`, async () => {
      const lakeStorage = new ObservedLake()
      const common = { lakeStorage, blobStorage: new InMemoryBlobStorage(), dataset: people }
      const seed = await writeDataset({
        ...common,
        mode: "snapshot",
        signal: new AbortController().signal,
        readValues: async () => [{ value: { id: "1", name: "Sam" } }],
      })
      const controller = new AbortController()
      const reason = new Error("delivery cancelled")
      await expect(
        writeDataset({
          ...common,
          mode,
          signal: controller.signal,
          readValues: async () =>
            (async function* () {
              const row = { id: "1", name: "Changed" }
              yield { value: mode === "merge" ? change.upsert(row) : row }
              controller.abort(reason)
            })(),
        })
      ).rejects.toBe(reason)
      expect(lakeStorage.aborts).toBe(1)
      expect((await lakeStorage.getLatestVersion(people.id))?.versionId).toBe(
        seed.version?.versionId
      )
      expect(await rows(lakeStorage)).toEqual([{ id: "1", name: "Sam" }])
    })
  }

  test("verifies blob existence, digest, and size for rows/upserts; deletes need only keys", async () => {
    // Regression proof: bypass verifyRowFileRefs in either validation path; invalid blobs commit.
    const blobStorage = new InMemoryBlobStorage()
    const ref = await blobStorage.put({ body: new TextEncoder().encode("source document") })
    const dataset = defineDataset("documents", {
      schema: [col("id", "string"), col("file", "fileRef")],
      primaryKey: "id",
    })
    for (const mode of ["snapshot", "merge"] as const) {
      for (const [stored, diagnostic] of [
        [null, `referencing unknown blob '${ref.blobId}'`],
        [
          { ...ref, digest: "sha256:wrong" },
          `with digest '${ref.digest}', but blob storage has 'sha256:wrong'`,
        ],
        [
          { ...ref, sizeBytes: ref.sizeBytes + 1 },
          `with size ${ref.sizeBytes}, but blob storage has ${ref.sizeBytes + 1}`,
        ],
      ] as const) {
        const lakeStorage = new ObservedLake()
        const row = { id: "1", file: ref }
        await expect(
          writeDataset({
            lakeStorage,
            blobStorage: { stat: async () => stored },
            dataset,
            mode,
            signal: new AbortController().signal,
            readValues: async () => [{ value: mode === "merge" ? change.upsert(row) : row }],
          })
        ).rejects.toThrow(diagnostic)
        expect(lakeStorage.aborts).toBe(1)
        expect(await lakeStorage.getLatestVersion(dataset.id)).toBeNull()
      }
    }
    const result = await writeDataset({
      lakeStorage: new InMemoryLakeStorage(),
      blobStorage: {
        stat: async () => {
          throw new Error("deletes must not read blobs")
        },
      },
      dataset,
      mode: "merge",
      signal: new AbortController().signal,
      readValues: async () => [{ value: change.delete({ id: "1" }) }],
    })
    expect(result).toEqual({ outcome: "unchanged", rowsRead: 1, version: null })
  })
})
