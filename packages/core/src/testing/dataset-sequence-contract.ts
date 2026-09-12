import { describe, expect, test } from "bun:test"
import { change, col, type DatasetDefinition, defineDataset, type MergeChange } from "../datasets"
import type { DatasetRow, LakeStorage } from "../lake-storage"
import type { LakeMergeStorageContractSuiteOptions } from "./lake-merge-storage-contract"

const dataset = defineDataset("contract.source_order", {
  schema: [
    col("id", "string"),
    col("revision", "int64"),
    col("name", "string"),
    col("details", "json", { nullable: true }),
  ],
  primaryKey: "id",
  sequenceBy: "revision",
})
const upsert = (revision: string | number, name = "Sam", id = "42") =>
  change.upsert({ id, revision, name })

async function merge(
  storage: LakeStorage,
  changes: readonly MergeChange<DatasetRow, DatasetRow>[],
  definition: DatasetDefinition = dataset
) {
  const session = await storage.beginMerge({ dataset: definition })
  try {
    await session.writeChanges(changes)
    return await session.commit()
  } catch (error) {
    await session.abort()
    throw error
  }
}

async function rows(storage: LakeStorage, definition = dataset) {
  const result: DatasetRow[] = []
  for await (const row of storage.readRows({ datasetId: definition.id })) result.push(row)
  return result
}

export function runDatasetSequenceContract<TStorage extends LakeStorage>(
  options: LakeMergeStorageContractSuiteOptions<TStorage>
): void {
  const withStorage = async (run: (storage: TStorage) => Promise<void>) => {
    const storage = await options.createStorage()
    try {
      await storage.createDataset(dataset)
      await run(storage)
    } finally {
      await options.teardown?.(storage)
    }
  }

  describe("source ordering", () => {
    test("rejects lossy timestamps outside the ordering column before changing source state", () =>
      withStorage(async (storage) => {
        // Regression proof: remove the sequenced timestamp check in getColumnValidationError;
        // submillisecond content is accepted and its distinct values collapse to one digest.
        const timestamps = defineDataset("contract.content_timestamps", {
          schema: [...dataset.schema.columns, col("at", "timestamp", { nullable: true })],
          primaryKey: "id",
          sequenceBy: "revision",
        })
        await storage.createDataset(timestamps)
        const row = (at: unknown, id = "42") => change.upsert({ id, revision: 1, name: "Sam", at })
        const initial = await merge(storage, [row("2026-09-09T10:00:00.123Z")], timestamps)
        for (const at of [
          "2026-09-09T10:00:00.123001Z",
          "2026-09-09T10:00:00.123999Z",
          "2026-09-09T10:00:00",
          "2026-02-30T00:00:00Z",
        ]) {
          await expect(merge(storage, [row(at, "new")], timestamps)).rejects.toThrow("column 'at'")
          expect(await storage.getLatestVersion(timestamps.id)).toEqual(initial.version)
        }
        for (const at of ["2026-09-09T12:00:00.123+02:00", new Date("2026-09-09T10:00:00.123Z")]) {
          expect((await merge(storage, [row(at)], timestamps)).outcome).toBe("unchanged")
        }
        await expect(merge(storage, [row("2026-09-09T10:00:00.124Z")], timestamps)).rejects.toThrow(
          "conflicting content"
        )
        await merge(storage, [row(null, "nullable")], timestamps)
        expect((await merge(storage, [row(undefined, "nullable")], timestamps)).outcome).toBe(
          "unchanged"
        )
      }))

    // Regression proof: bypass reconcileDatasetSequences at the provider commit boundary.
    // The stale-write, conflict, and deletion assertions below must then fail.
    test("orders repeated keys exactly and conflicts atomically", () =>
      withStorage(async (storage) => {
        const first = await merge(storage, [upsert("9007199254740993")])
        expect((await merge(storage, [upsert("9007199254740992", "stale")])).outcome).toBe(
          "unchanged"
        )
        expect((await merge(storage, [upsert("09007199254740993")])).outcome).toBe("unchanged")
        await expect(
          merge(storage, [upsert("1", "other", "other"), upsert("9007199254740993", "conflict")])
        ).rejects.toThrow("conflicting content")
        expect((await storage.getLatestVersion(dataset.id))?.versionId).toBe(
          first.version?.versionId
        )
        expect(await rows(storage)).toHaveLength(1)
        await merge(storage, [
          upsert("9007199254740995", "newest"),
          upsert("9007199254740994", "stale"),
        ])
        expect((await rows(storage))[0]?.name).toBe("newest")
        await expect(
          merge(storage, [upsert("9007199254740996", "a"), upsert("9007199254740996", "b")])
        ).rejects.toThrow("conflicting content")
        expect((await rows(storage))[0]?.name).toBe("newest")
      }))

    test("retains absent-key deletions and protects their version boundary", () =>
      withStorage(async (storage) => {
        const staleSession = await storage.beginMerge({ dataset })
        await staleSession.writeChanges([upsert(8)])
        const deleted = await merge(storage, [change.delete({ id: "42" }, { sequence: 9 })])
        expect(deleted).toMatchObject({ outcome: "created", version: { rowCount: 0 } })
        await expect(staleSession.commit()).rejects.toThrow("Optimistic")
        await staleSession.abort()
        expect((await merge(storage, [upsert(8)])).outcome).toBe("unchanged")
        expect(
          (await merge(storage, [change.delete({ id: "42" }, { sequence: "9" })])).outcome
        ).toBe("unchanged")
        await expect(merge(storage, [upsert(9)])).rejects.toThrow("conflicting content")
        await merge(storage, [upsert(10)])
        expect(await rows(storage)).toHaveLength(1)
        expect((await merge(storage, [change.delete({ id: "42" }, { sequence: 9 })])).outcome).toBe(
          "unchanged"
        )
        await merge(storage, [change.delete({ id: "42" }, { sequence: 11 })])
        expect(await rows(storage)).toEqual([])
      }))

    test("compares canonical content across JSON order and nullable representations", () =>
      withStorage(async (storage) => {
        await merge(storage, [
          change.upsert({ id: "42", revision: 1, name: "Sam", details: { a: 1, b: 2 } }),
        ])
        expect(
          (
            await merge(storage, [
              change.upsert({ id: "42", revision: "01", name: "Sam", details: { b: 2, a: 1 } }),
            ])
          ).outcome
        ).toBe("unchanged")
        await merge(storage, [upsert(2)])
        expect(
          (
            await merge(storage, [
              change.upsert({ id: "42", revision: "2", name: "Sam", details: null }),
            ])
          ).outcome
        ).toBe("unchanged")
      }))

    test("validates integer ranges and delete sequences at the provider boundary", () =>
      withStorage(async (storage) => {
        for (const revision of [
          null,
          undefined,
          1.5,
          Number.MAX_SAFE_INTEGER + 1,
          "9223372036854775808",
          "-9223372036854775809",
          "1e3",
        ]) {
          await expect(
            merge(storage, [change.upsert({ id: "42", revision, name: "Sam" })])
          ).rejects.toThrow("sequence")
        }
        await expect(merge(storage, [change.delete({ id: "42" })])).rejects.toThrow("sequence")
        await merge(storage, [upsert("-9223372036854775808"), upsert("9223372036854775807")])
        expect((await rows(storage))[0]?.revision?.toString()).toBe("9223372036854775807")
      }))

    test("normalizes timezone-aware timestamps without discarding precision", () =>
      withStorage(async (storage) => {
        const timestamps = defineDataset("contract.source_timestamps", {
          schema: [col("id", "string"), col("updated", "timestamp"), col("name", "string")],
          primaryKey: "id",
          sequenceBy: "updated",
        })
        await storage.createDataset(timestamps)
        const row = (updated: unknown, name = "Sam") => change.upsert({ id: "42", updated, name })
        await merge(storage, [row("2026-09-09T10:00:00.123Z")], timestamps)
        for (const updated of [
          "2026-09-09T12:00:00.123+02:00",
          new Date("2026-09-09T10:00:00.123Z"),
        ]) {
          expect((await merge(storage, [row(updated)], timestamps)).outcome).toBe("unchanged")
        }
        for (const updated of [
          "2026-09-09T10:00:00.1234Z",
          "2026-09-09T10:00:00",
          "2026-02-30T00:00:00Z",
          new Date(Number.NaN),
        ]) {
          await expect(merge(storage, [row(updated)], timestamps)).rejects.toThrow("sequence")
        }
        await merge(
          storage,
          [change.delete({ id: "42" }, { sequence: "2026-09-09T10:00:00.124Z" })],
          timestamps
        )
        expect((await merge(storage, [row("2026-09-09T10:00:00.123Z")], timestamps)).outcome).toBe(
          "unchanged"
        )
      }))

    test("round-trips immutable sequencing and rejects writes that bypass ordering", () =>
      withStorage(async (storage) => {
        expect((await storage.getDataset(dataset.id))?.sequenceBy).toBe("revision")
        expect(
          (await storage.listDatasets()).find((item) => item.id === dataset.id)?.sequenceBy
        ).toBe("revision")
        const { sequenceBy: _, ...unsequenced } = dataset
        await expect(storage.createDataset(unsequenced)).rejects.toThrow("immutable")
        await storage.createDataset({ ...unsequenced, id: "legacy" })
        await expect(storage.createDataset({ ...dataset, id: "legacy" })).rejects.toThrow(
          "immutable"
        )
        await expect(
          storage.createDataset({ ...dataset, id: "invalid", primaryKey: undefined })
        ).rejects.toThrow("sequenceBy")
        await expect(
          storage.createDataset({ ...dataset, id: "invalid", sequenceBy: "name" })
        ).rejects.toThrow("sequenceBy")
        await expect(storage.beginWrite({ dataset })).rejects.toThrow("beginMerge")
      }))

    const reopen = options.reopen
    if (reopen)
      test("preserves source state after reopen", async () => {
        let storage = await options.createStorage()
        try {
          await storage.createDataset(dataset)
          await merge(storage, [
            upsert(8, "visible", "visible"),
            change.delete({ id: "42" }, { sequence: 9 }),
          ])
          storage = await reopen(storage)
          expect((await storage.getDataset(dataset.id))?.sequenceBy).toBe("revision")
          expect((await merge(storage, [upsert(8), upsert(7, "stale", "visible")])).outcome).toBe(
            "unchanged"
          )
          expect(await rows(storage)).toHaveLength(1)
          await merge(storage, [upsert(10)])
          expect(await rows(storage)).toHaveLength(2)
        } finally {
          await options.teardown?.(storage)
        }
      })
  })
}
