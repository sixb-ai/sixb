import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { col, defineDataset } from "../datasets"
import type { DatasetChanges, DatasetRow, DatasetRowChange, LakeStorage } from "../lake-storage"

export function runLakeChangesContractSuite<T extends LakeStorage>(
  name: string,
  harness: {
    readonly createStorage: () => T | Promise<T>
    readonly teardown?: (storage: T) => void | Promise<void>
  }
): void {
  describe(name, () => {
    let storage: T
    const dataset = defineDataset("delta.contract", {
      schema: [
        col("id", "string"),
        col("part", "string"),
        col("value", "string", { nullable: true }),
        col("ignored", "string"),
      ],
    })
    const row = (id: string, value: string | null, part = "x", ignored = "unused"): DatasetRow => ({
      id,
      part,
      value,
      ignored,
    })
    const columns = ["id", "part", "value"]
    beforeEach(async () => {
      storage = await harness.createStorage()
      await storage.createDataset(dataset)
    })
    afterEach(async () => {
      if (harness.teardown) await harness.teardown(storage)
      else await storage.close?.()
    })
    async function write(rows: readonly DatasetRow[]) {
      const writer = await storage.beginWrite({ dataset })
      await writer.writeRows(rows)
      return (await writer.commit()).versionId
    }
    async function read(fromVersionId: string, toVersionId: string, keyColumns = ["id"]) {
      if (!storage.readChanges) throw new Error("Provider does not implement readChanges")
      return storage.readChanges({
        datasetId: dataset.id,
        fromVersionId,
        toVersionId,
        columns,
        keyColumns,
      })
    }
    async function collect(reader: DatasetChanges | null) {
      if (!reader) throw new Error("Expected a complete delta")
      const changes: DatasetRowChange[] = []
      try {
        for await (const change of reader.changes) changes.push(change)
      } finally {
        await reader.close()
      }
      expect(changes).toHaveLength(reader.changeCount)
      return changes.sort((a, b) =>
        JSON.stringify(a.after ?? a.before).localeCompare(JSON.stringify(b.after ?? b.before))
      )
    }

    // Red proof: remove the provider's readChanges implementation; this suite must fail.
    test("compares pinned states across skipped versions, including removals and key changes", async () => {
      const first = await write([row("A", "one"), row("B", "two"), row("C", "three")])
      await write([row("A", "temporary"), row("B", "two"), row("C", "three")])
      const last = await write([row("A", "one"), row("B", "new"), row("D", "three")])
      const reader = await read(first, last)
      expect(reader?.fromRowCount).toBe(3)
      expect(reader?.toRowCount).toBe(3)
      expect(await collect(reader)).toEqual([
        {
          before: { id: "B", part: "x", value: "two" },
          after: { id: "B", part: "x", value: "new" },
        },
        { before: { id: "C", part: "x", value: "three" }, after: null },
        { before: null, after: { id: "D", part: "x", value: "three" } },
      ])
    })
    test("ignores row order and unrequested columns", async () => {
      const first = await write([row("A", "one"), row("B", "two")])
      const last = await write([row("B", "two", "x", "changed"), row("A", "one")])
      expect(await collect(await read(first, last))).toEqual([])
      expect(await collect(await read(last, last))).toEqual([])
    })
    test("distinguishes null from a value and handles an empty target", async () => {
      const first = await write([row("A", null)])
      const second = await write([row("A", "value")])
      expect(await collect(await read(first, second))).toEqual([
        {
          before: { id: "A", part: "x", value: null },
          after: { id: "A", part: "x", value: "value" },
        },
      ])
      const empty = await write([])
      expect(await collect(await read(second, empty))).toEqual([
        { before: { id: "A", part: "x", value: "value" }, after: null },
      ])
      expect(await collect(await read(empty, second))).toEqual([
        { before: null, after: { id: "A", part: "x", value: "value" } },
      ])
    })
    test("supports composite keys without concatenation collisions", async () => {
      const first = await write([row("a:b", "one", "c"), row("a", "two", "b:c")])
      const last = await write([row("a:b", "new", "c"), row("a", "two", "b:c")])
      expect(await collect(await read(first, last, ["id", "part"]))).toEqual([
        {
          before: { id: "a:b", part: "c", value: "one" },
          after: { id: "a:b", part: "c", value: "new" },
        },
      ])
    })
    test("refuses duplicate keys in either snapshot rather than losing rows", async () => {
      const first = await write([row("A", "one"), row("A", "two")])
      const last = await write([row("A", "new")])
      expect(await read(first, last)).toBeNull()
      expect(await read(last, first)).toBeNull()
    })
    test("refuses blank identities and invalid column requests", async () => {
      const first = await write([row(" ", "one")])
      expect(await read(first, first)).toBeNull()
      await expect(read(first, first, [])).rejects.toThrow("distinct columns")
      await expect(read(first, first, ["missing"])).rejects.toThrow("distinct columns")
    })
    test("releases the connection between yielded changes and closes after early exit", async () => {
      const first = await write([row("A", "one"), row("B", "two")])
      const last = await write([row("A", "new"), row("B", "new")])
      const reader = await read(first, last)
      expect(reader).not.toBeNull()
      try {
        for await (const _change of reader!.changes) {
          expect((await storage.getLatestVersion(dataset.id))?.versionId).toBe(last)
          break
        }
      } finally {
        await reader!.close()
      }
      expect((await storage.getLatestVersion(dataset.id))?.versionId).toBe(last)
    })
    test("pages a complete pinned delta while a newer snapshot is published", async () => {
      const count = 5_007
      const first = await write(Array.from({ length: count }, (_, i) => row(String(i), "old")))
      const last = await write(Array.from({ length: count }, (_, i) => row(String(i), "new")))
      const reader = await read(first, last)
      expect(reader?.changeCount).toBe(count)
      await write([row("later", "unrelated")])
      const changes = await collect(reader)
      expect(new Set(changes.map((change) => change.after?.id)).size).toBe(count)
      expect(
        changes.every((change) => change.before?.value === "old" && change.after?.value === "new")
      ).toBe(true)
    })
    test("returns complete typed images without exposing mutable stored values", async () => {
      const typed = defineDataset("delta.typed", {
        schema: [
          col("id", "string"),
          col("payload", "json"),
          col("at", "timestamp"),
          col("amount", "int64"),
        ],
      })
      await storage.createDataset(typed)
      const writeTyped = async (value: number) => {
        const writer = await storage.beginWrite({ dataset: typed })
        await writer.writeRows([
          {
            id: "a",
            payload: { nested: [value] },
            at: "2026-01-01T00:00:00.000Z",
            amount: "9007199254740993",
          },
        ])
        return (await writer.commit()).versionId
      }
      const first = await writeTyped(1)
      const last = await writeTyped(2)
      const reader = await storage.readChanges!({
        datasetId: typed.id,
        fromVersionId: first,
        toVersionId: last,
        keyColumns: ["id"],
        columns: ["id", "payload", "at", "amount"],
      })
      const changes = await collect(reader)
      expect(changes).toEqual([
        {
          before: {
            id: "a",
            payload: { nested: [1] },
            at: "2026-01-01T00:00:00.000Z",
            amount: "9007199254740993",
          },
          after: {
            id: "a",
            payload: { nested: [2] },
            at: "2026-01-01T00:00:00.000Z",
            amount: "9007199254740993",
          },
        },
      ])
      ;(changes[0]!.after!.payload as { nested: number[] }).nested.push(3)
      const rows: DatasetRow[] = []
      for await (const value of storage.readRows({ datasetId: typed.id, versionId: last }))
        rows.push(value)
      expect(rows[0]?.payload).toEqual({ nested: [2] })
    })
    test("returns unavailable for a version belonging to another dataset", async () => {
      const first = await write([row("A", "one")])
      const other = defineDataset("delta.other", { schema: [col("id", "string")] })
      await storage.createDataset(other)
      const writer = await storage.beginWrite({ dataset: other })
      await writer.writeRows([{ id: "other" }])
      const otherVersion = await writer.commit()
      expect(await read(otherVersion.versionId, first)).toBeNull()
      expect(await read(first, otherVersion.versionId)).toBeNull()
    })
    test("can close an unread delta and observes cancellation", async () => {
      const first = await write([row("A", "one")])
      const last = await write([row("A", "new")])
      const reader = await read(first, last)
      await reader!.close()
      await reader!.close()
      const controller = new AbortController()
      controller.abort(new Error("cancelled delta"))
      await expect(
        storage.readChanges!({
          datasetId: dataset.id,
          fromVersionId: first,
          toVersionId: last,
          columns,
          keyColumns: ["id"],
          signal: controller.signal,
        })
      ).rejects.toThrow("cancelled delta")
    })
  })
}
