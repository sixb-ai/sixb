import { describe, expect, test } from "bun:test"
import { change, col, defineDataset } from "../datasets"
import type { DatasetMergeCommitResult, DatasetRow, LakeStorage } from "../lake-storage"

export interface LakeMergeStorageContractSuiteOptions<
  TStorage extends LakeStorage & Required<Pick<LakeStorage, "beginMerge">> = LakeStorage &
    Required<Pick<LakeStorage, "beginMerge">>,
> {
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly teardown?: (storage: TStorage) => void | Promise<void>
}

const invoices = defineDataset("contract.merges.invoices", {
  schema: [col("id", "string"), col("status", "string"), col("note", "string", { nullable: true })],
  primaryKey: "id",
})

const lineItems = defineDataset("contract.merges.line_items", {
  schema: [col("invoiceId", "string"), col("lineItemId", "string"), col("description", "string")],
  primaryKey: ["invoiceId", "lineItemId"],
})

const unkeyed = defineDataset("contract.merges.unkeyed", {
  schema: [col("id", "string")],
})

export function runLakeMergeStorageContractSuite<
  TStorage extends LakeStorage & Required<Pick<LakeStorage, "beginMerge">>,
>(label: string, options: LakeMergeStorageContractSuiteOptions<TStorage>): void {
  const withStorage = async (body: (storage: TStorage) => Promise<void>): Promise<void> => {
    const storage = await options.createStorage()
    try {
      await body(storage)
    } finally {
      await options.teardown?.(storage)
    }
  }

  describe(label, () => {
    test("creates an initial merge version from async changes", async () => {
      await withStorage(async (storage) => {
        await storage.createDataset(invoices)
        const merge = await storage.beginMerge({
          dataset: invoices,
          producer: { kind: "sync", id: "sync-invoices", runId: "run_1" },
          inputs: [{ datasetId: "source.events", versionId: "cursor_1" }],
        })

        async function* changes() {
          yield change.upsert({ id: "inv_1", status: "open", note: null })
          yield change.upsert({ id: "inv_2", status: "paid", note: "settled" })
        }

        await merge.writeChanges(changes())
        const result = await merge.commit({ commitMessage: "initial invoice changes" })
        const version = expectCreated(result)

        expect(version).toMatchObject({
          datasetId: invoices.id,
          mode: "merge",
          rowCount: 2,
          producer: { kind: "sync", id: "sync-invoices", runId: "run_1" },
          inputs: [{ datasetId: "source.events", versionId: "cursor_1" }],
        })
        expect(version.parentVersionId).toBeUndefined()
        await expect(collectRows(storage.readRows({ datasetId: invoices.id }))).resolves.toEqual([
          { id: "inv_1", status: "open", note: null },
          { id: "inv_2", status: "paid", note: "settled" },
        ])
      })
    })

    test("inserts, updates, and deletes while preserving the parent version", async () => {
      await withStorage(async (storage) => {
        await storage.createDataset(invoices)
        const seed = await storage.beginWrite({ dataset: invoices, mode: "snapshot" })
        await seed.writeRows([
          { id: "inv_1", status: "open", note: null },
          { id: "inv_2", status: "open", note: null },
        ])
        const parent = await seed.commit()

        const merge = await storage.beginMerge({ dataset: invoices })
        await merge.writeChanges([
          change.upsert({ id: "inv_1", status: "paid", note: null }),
          // Primary keys are immutable, so moving a row is an old-key delete plus a complete row.
          change.delete({ id: "inv_2" }),
          change.upsert({ id: "inv_2_moved", status: "open", note: "moved" }),
        ])
        const version = expectCreated(await merge.commit())

        expect(version.parentVersionId).toBe(parent.versionId)
        expect(version.mode).toBe("merge")
        await expect(collectRows(storage.readRows({ datasetId: invoices.id }))).resolves.toEqual([
          { id: "inv_1", status: "paid", note: null },
          { id: "inv_2_moved", status: "open", note: "moved" },
        ])
        await expect(
          collectRows(storage.readRows({ datasetId: invoices.id, versionId: parent.versionId }))
        ).resolves.toEqual([
          { id: "inv_1", status: "open", note: null },
          { id: "inv_2", status: "open", note: null },
        ])
      })
    })

    test("applies the final change for repeated single and composite keys", async () => {
      await withStorage(async (storage) => {
        await storage.createDataset(lineItems)
        const merge = await storage.beginMerge({ dataset: lineItems })
        await merge.writeChanges([
          change.upsert({ invoiceId: "a|b", lineItemId: "c", description: "first" }),
          change.upsert({ invoiceId: "a", lineItemId: "b|c", description: "other key" }),
        ])
        await merge.writeChanges([
          change.delete({ invoiceId: "a|b", lineItemId: "c" }),
          change.upsert({ invoiceId: "a|b", lineItemId: "c", description: "final" }),
        ])
        expectCreated(await merge.commit())

        await expect(collectRows(storage.readRows({ datasetId: lineItems.id }))).resolves.toEqual([
          { invoiceId: "a|b", lineItemId: "c", description: "final" },
          { invoiceId: "a", lineItemId: "b|c", description: "other key" },
        ])
      })
    })

    test("does not create versions when visible rows do not change", async () => {
      await withStorage(async (storage) => {
        await storage.createDataset(invoices)

        const empty = await storage.beginMerge({ dataset: invoices })
        expect(await empty.commit()).toEqual({ outcome: "unchanged", version: null })

        const initialNoOp = await storage.beginMerge({ dataset: invoices })
        await initialNoOp.writeChanges([change.delete({ id: "missing" })])
        expect(await initialNoOp.commit()).toEqual({ outcome: "unchanged", version: null })
        expect(await storage.listVersions(invoices.id)).toEqual([])

        const seed = await storage.beginMerge({ dataset: invoices })
        await seed.writeChanges([change.upsert({ id: "inv_1", status: "open", note: null })])
        const seedVersion = expectCreated(await seed.commit())

        const identical = await storage.beginMerge({ dataset: invoices })
        await identical.writeChanges([change.upsert({ id: "inv_1", status: "open", note: null })])
        expect(await identical.commit()).toMatchObject({
          outcome: "unchanged",
          version: { versionId: seedVersion.versionId },
        })

        const laterNoOp = await storage.beginMerge({ dataset: invoices })
        await laterNoOp.writeChanges([
          change.upsert({ id: "inv_1", status: "paid", note: null }),
          change.upsert({ id: "inv_1", status: "open" }),
          change.delete({ id: "missing" }),
        ])
        const noOpResult = await laterNoOp.commit()

        expect(noOpResult).toMatchObject({ outcome: "unchanged" })
        expect(noOpResult.version?.versionId).toBe(seedVersion.versionId)
        expect(await storage.listVersions(invoices.id)).toHaveLength(1)
      })
    })

    test("automatically rejects stale merge sessions, including an absent base", async () => {
      await withStorage(async (storage) => {
        await storage.createDataset(invoices)
        const first = await storage.beginMerge({ dataset: invoices })
        const stale = await storage.beginMerge({ dataset: invoices })

        await first.writeChanges([change.upsert({ id: "inv_1", status: "open" })])
        await first.commit()
        await stale.writeChanges([change.upsert({ id: "inv_2", status: "open" })])

        await expect(stale.commit()).rejects.toThrow("Optimistic merge commit failed")
        await expect(collectRows(storage.readRows({ datasetId: invoices.id }))).resolves.toEqual([
          { id: "inv_1", status: "open" },
        ])
      })
    })

    test("serializes concurrent commits from the same base", async () => {
      // Regression guard: bypassing a provider's per-dataset commit lock lets both commits create
      // versions from the same base and makes the fulfilled-count assertion fail.
      await withStorage(async (storage) => {
        await storage.createDataset(invoices)
        const left = await storage.beginMerge({ dataset: invoices })
        const right = await storage.beginMerge({ dataset: invoices })
        await left.writeChanges([change.upsert({ id: "inv_left", status: "open" })])
        await right.writeChanges([change.upsert({ id: "inv_right", status: "open" })])

        const results = await Promise.allSettled([left.commit(), right.commit()])

        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
        expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
        expect(await storage.listVersions(invoices.id)).toHaveLength(1)
        expect(await collectRows(storage.readRows({ datasetId: invoices.id }))).toHaveLength(1)
      })
    })

    test("rejects unkeyed datasets and malformed changes", async () => {
      await withStorage(async (storage) => {
        await storage.createDataset(unkeyed)
        await expect(storage.beginMerge({ dataset: unkeyed })).rejects.toThrow(
          "must define a primaryKey"
        )

        await storage.createDataset(invoices)
        const merge = await storage.beginMerge({ dataset: invoices })
        await expect(merge.writeChanges([change.upsert({ id: "inv_1" })])).rejects.toThrow(
          "missing required column 'status'"
        )
        await expect(merge.writeChanges([change.delete({})])).rejects.toThrow(
          "missing primary-key column 'id'"
        )
        await expect(
          merge.writeChanges([{ kind: "delete", key: { id: "inv_1", extra: "x" } }])
        ).rejects.toThrow("unknown column 'extra'")
        await merge.abort()
      })
    })

    test("enforces unique keys for snapshot and append baselines", async () => {
      await withStorage(async (storage) => {
        await storage.createDataset(invoices)

        const duplicateSnapshot = await storage.beginWrite({ dataset: invoices, mode: "snapshot" })
        await expect(
          duplicateSnapshot.writeRows([
            { id: "inv_1", status: "open" },
            { id: "inv_1", status: "paid" },
          ])
        ).rejects.toThrow("duplicate primary key")
        await duplicateSnapshot.abort()

        const seed = await storage.beginWrite({ dataset: invoices, mode: "snapshot" })
        await seed.writeRows([{ id: "inv_1", status: "open" }])
        await seed.commit()

        const conflictingAppend = await storage.beginWrite({ dataset: invoices, mode: "append" })
        await conflictingAppend.writeRows([{ id: "inv_1", status: "paid" }])
        await expect(conflictingAppend.commit()).rejects.toThrow("duplicate primary key")
      })
    })

    test("clones staged changes and enforces the session lifecycle", async () => {
      await withStorage(async (storage) => {
        await storage.createDataset(invoices)
        const row = { id: "inv_1", status: "open" }
        const merge = await storage.beginMerge({ dataset: invoices })
        await merge.writeChanges([change.upsert(row)])
        row.status = "paid"
        expectCreated(await merge.commit())
        await merge.abort()

        await expect(merge.writeChanges([])).rejects.toThrow("already closed")
        await expect(collectRows(storage.readRows({ datasetId: invoices.id }))).resolves.toEqual([
          { id: "inv_1", status: "open" },
        ])

        const aborted = await storage.beginMerge({ dataset: invoices })
        await aborted.writeChanges([change.delete({ id: "inv_1" })])
        await aborted.abort()
        await aborted.abort()
        expect(await storage.listVersions(invoices.id)).toHaveLength(1)
      })
    })
  })
}

function expectCreated(result: DatasetMergeCommitResult) {
  expect(result.outcome).toBe("created")
  if (result.outcome !== "created") {
    throw new Error("Expected merge to create a dataset version")
  }
  return result.version
}

async function collectRows(rows: AsyncIterable<DatasetRow>): Promise<DatasetRow[]> {
  const result: DatasetRow[] = []
  for await (const row of rows) {
    result.push(row)
  }
  return result
}
