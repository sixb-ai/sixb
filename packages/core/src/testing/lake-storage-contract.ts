import { describe, expect, test } from "bun:test"
import type { FileRef } from "../blob-storage"
import { col, defineDataset } from "../datasets"
import { LakeStorageError } from "../lake-storage/errors"
import type { DatasetRow, LakeStorage } from "../lake-storage/types"

export type LakeStorageSchemaEvolutionCapability = "strict" | "addNullableColumns"

export interface LakeStorageContractSuiteOptions<TStorage extends LakeStorage = LakeStorage> {
  /** Factory that produces a fresh `LakeStorage` instance for each test case. */
  readonly createStorage: () => TStorage | Promise<TStorage>
  /** Optional cleanup invoked after every test case. */
  readonly teardown?: (storage: TStorage) => void | Promise<void>
  /**
   * Dataset definition update policy supported by the provider. Defaults to
   * `strict`, which allows metadata-only merges but rejects schema evolution.
   */
  readonly schemaEvolution?: LakeStorageSchemaEvolutionCapability
  /**
   * Version id that is syntactically valid for the provider but should not
   * exist. Defaults to a generic id accepted by providers without format
   * restrictions.
   */
  readonly missingVersionId?: string
}

const definitionDataset = defineDataset("contract.definitions.orders", {
  schema: [col("orderId", "string"), col("customerName", "string")],
  description: "Contract orders",
})

const reorderedDefinitionDataset = defineDataset("contract.definitions.orders", {
  schema: [col("customerName", "string"), col("orderId", "string")],
  description: "Contract orders",
})

const writeDataset = defineDataset("contract.writes.orders", {
  schema: [col("orderId", "string"), col("customerName", "string")],
})

const fileRefDataset = defineDataset("contract.files.documents", {
  schema: [col("id", "string"), col("attachment", "fileRef", { nullable: true })],
})

const invoiceRef: FileRef = {
  blobId: `blob_${"a".repeat(64)}`,
  digest: `sha256:${"a".repeat(64)}`,
  sizeBytes: 15,
  fileName: "invoice.txt",
  mediaType: "text/plain",
  logicalPath: "invoices/invoice.txt",
}

/**
 * Runs the shared `LakeStorage` contract against any provider.
 *
 * The suite covers provider-independent Lake semantics: definition
 * materialization and compatibility checks, versioned writes and reads,
 * optimistic commits, write-session lifecycle, and row validation.
 */
export function runLakeStorageContractSuite<TStorage extends LakeStorage>(
  label: string,
  options: LakeStorageContractSuiteOptions<TStorage>
): void {
  const schemaEvolution = options.schemaEvolution ?? "strict"
  const missingVersionId = options.missingVersionId ?? "missing-version"

  const withStorage = async (body: (storage: TStorage) => Promise<void>): Promise<void> => {
    const storage = await options.createStorage()
    try {
      await body(storage)
    } finally {
      await options.teardown?.(storage)
    }
  }

  describe(label, () => {
    describe("dataset definitions", () => {
      test("creates, gets, lists, and reuses dataset definitions", async () => {
        await withStorage(async (storage) => {
          expect(await storage.getDataset(definitionDataset.id)).toBeNull()

          const created = await storage.createDataset(definitionDataset)
          const repeated = await storage.createDataset(definitionDataset)

          expect(created).toEqual(definitionDataset)
          expect(repeated).toEqual(definitionDataset)
          expect(await storage.getDataset(definitionDataset.id)).toEqual(definitionDataset)
          expect(await storage.getDataset("missing.dataset")).toBeNull()
          expect(await storage.listDatasets()).toEqual([definitionDataset])
          expect(await storage.listVersions(definitionDataset.id)).toEqual([])
        })
      })

      test("treats same-column declaration reorders as a no-op", async () => {
        await withStorage(async (storage) => {
          await storage.createDataset(definitionDataset)
          await storage.assertDatasetDefinitionCompatible(reorderedDefinitionDataset)

          expect(await storage.getDataset(definitionDataset.id)).toEqual(definitionDataset)
          await expect(storage.createDataset(reorderedDefinitionDataset)).resolves.toEqual(
            definitionDataset
          )
          expect(await storage.listVersions(definitionDataset.id)).toEqual([])
        })
      })

      test("persists compatible metadata additions", async () => {
        await withStorage(async (storage) => {
          const minimalDataset = defineDataset("contract.definitions.metadata", {
            schema: [col("orderId", "string"), col("orderDate", "date")],
          })
          const documentedDataset = defineDataset("contract.definitions.metadata", {
            schema: [col("orderId", "string"), col("orderDate", "date")],
            partitionBy: ["orderDate"],
            description: "Contract metadata",
          })

          await storage.createDataset(minimalDataset)
          await storage.assertDatasetDefinitionCompatible(documentedDataset)

          expect(await storage.getDataset(minimalDataset.id)).toEqual(minimalDataset)
          await expect(storage.createDataset(documentedDataset)).resolves.toEqual(documentedDataset)
          expect(await storage.getDataset(minimalDataset.id)).toEqual(documentedDataset)
        })
      })

      test("rejects incompatible definition changes without mutating the stored definition", async () => {
        await withStorage(async (storage) => {
          const changedDataset = defineDataset(definitionDataset.id, {
            schema: [col("orderId", "int64"), col("customerName", "string")],
            description: "Contract orders",
          })

          await storage.createDataset(definitionDataset)

          await expect(storage.assertDatasetDefinitionCompatible(changedDataset)).rejects.toThrow(
            "changing column 'orderId' type"
          )
          await expect(storage.createDataset(changedDataset)).rejects.toBeInstanceOf(
            LakeStorageError
          )
          expect(await storage.getDataset(definitionDataset.id)).toEqual(definitionDataset)
        })
      })

      test("checks provider schema evolution policy", async () => {
        await withStorage(async (storage) => {
          const initialDataset = defineDataset("contract.definitions.schema_evolution", {
            schema: [col("invoiceId", "string")],
          })
          const requestedDataset = defineDataset("contract.definitions.schema_evolution", {
            schema: [col("currency", "string", { nullable: true }), col("invoiceId", "string")],
          })
          const storedDataset = defineDataset("contract.definitions.schema_evolution", {
            schema: [col("invoiceId", "string"), col("currency", "string", { nullable: true })],
          })

          await storage.createDataset(initialDataset)

          if (schemaEvolution === "strict") {
            await expect(
              storage.assertDatasetDefinitionCompatible(requestedDataset)
            ).rejects.toThrow("incompatible schema")
            await expect(storage.createDataset(requestedDataset)).rejects.toThrow(
              "incompatible schema"
            )
            expect(await storage.getDataset(initialDataset.id)).toEqual(initialDataset)
            return
          }

          await storage.assertDatasetDefinitionCompatible(requestedDataset)
          expect(await storage.getDataset(initialDataset.id)).toEqual(initialDataset)
          expect(await storage.listVersions(initialDataset.id)).toEqual([])

          await expect(storage.createDataset(requestedDataset)).resolves.toEqual(storedDataset)
          expect(await storage.getDataset(initialDataset.id)).toEqual(storedDataset)

          const [schemaVersion] = await storage.listVersions(initialDataset.id)
          expect(schemaVersion).toMatchObject({
            datasetId: initialDataset.id,
            mode: "schema",
            schema: storedDataset.schema,
          })
        })
      })

      test("keeps compatibility checks read-only for missing datasets", async () => {
        await withStorage(async (storage) => {
          await storage.assertDatasetDefinitionCompatible(definitionDataset)

          expect(await storage.getDataset(definitionDataset.id)).toBeNull()
          expect(await storage.listDatasets()).toEqual([])
        })
      })
    })

    describe("writes and reads", () => {
      test("rejects writes for unknown datasets", async () => {
        await withStorage(async (storage) => {
          await expect(storage.beginWrite({ dataset: writeDataset })).rejects.toThrow(
            "Unknown dataset"
          )
        })
      })

      test("commits snapshot and append versions with versioned reads", async () => {
        await withStorage(async (storage) => {
          await storage.createDataset(writeDataset)

          const snapshotWrite = await storage.beginWrite({
            dataset: writeDataset,
            mode: "snapshot",
            producer: { kind: "sync", id: "contract-sync", runId: "run_1" },
          })
          await snapshotWrite.writeRows([
            { orderId: "ord_1", customerName: "Ada" },
            { orderId: "ord_2", customerName: "Grace" },
          ])
          const version1 = await snapshotWrite.commit({ commitMessage: "snapshot orders" })

          expect(version1).toMatchObject({
            datasetId: writeDataset.id,
            mode: "snapshot",
            schema: writeDataset.schema,
            producer: { kind: "sync", id: "contract-sync", runId: "run_1" },
            rowCount: 2,
          })
          expect(version1.parentVersionId).toBeUndefined()
          expect(await storage.getLatestVersion(writeDataset.id)).toMatchObject({
            versionId: version1.versionId,
          })
          expect(await storage.getVersion(writeDataset.id, version1.versionId)).toMatchObject({
            datasetId: writeDataset.id,
            versionId: version1.versionId,
            mode: "snapshot",
            rowCount: 2,
          })

          await Bun.sleep(2)

          const appendWrite = await storage.beginWrite({
            dataset: writeDataset,
            mode: "append",
            inputs: [{ datasetId: writeDataset.id, versionId: version1.versionId }],
          })
          await appendWrite.writeRows([{ orderId: "ord_3", customerName: "Katherine" }])
          const version2 = await appendWrite.commit({
            expectedLatestVersionId: version1.versionId,
          })

          expect(version2).toMatchObject({
            datasetId: writeDataset.id,
            parentVersionId: version1.versionId,
            mode: "append",
            schema: writeDataset.schema,
            inputs: [{ datasetId: writeDataset.id, versionId: version1.versionId }],
            rowCount: 3,
          })
          expect(await storage.getLatestVersion(writeDataset.id)).toMatchObject({
            versionId: version2.versionId,
          })

          await expect(
            collectRows(storage.readRows({ datasetId: writeDataset.id }))
          ).resolves.toEqual([
            { orderId: "ord_1", customerName: "Ada" },
            { orderId: "ord_2", customerName: "Grace" },
            { orderId: "ord_3", customerName: "Katherine" },
          ])
          await expect(
            collectRows(
              storage.readRows({ datasetId: writeDataset.id, versionId: version1.versionId })
            )
          ).resolves.toEqual([
            { orderId: "ord_1", customerName: "Ada" },
            { orderId: "ord_2", customerName: "Grace" },
          ])
          await expect(
            collectRows(
              storage.readRows({
                datasetId: writeDataset.id,
                columns: ["orderId"],
                limit: 2,
              })
            )
          ).resolves.toEqual([{ orderId: "ord_1" }, { orderId: "ord_2" }])
          await expect(
            collectRows(
              storage.readRows({
                datasetId: writeDataset.id,
                columns: ["orderId"],
                limit: 1,
                offset: 1,
              })
            )
          ).resolves.toEqual([{ orderId: "ord_2" }])
          await expect(
            collectRows(
              storage.readRows({
                datasetId: writeDataset.id,
                columns: ["orderId"],
                offset: 1,
              })
            )
          ).resolves.toEqual([{ orderId: "ord_2" }, { orderId: "ord_3" }])

          expect(
            (await storage.listVersions(writeDataset.id)).map((version) => version.versionId)
          ).toEqual([version2.versionId, version1.versionId])
          expect(
            (await storage.listVersions(writeDataset.id, 1)).map((version) => version.versionId)
          ).toEqual([version2.versionId])
          expect(await storage.listVersions("missing.dataset")).toEqual([])
          expect(await storage.getLatestVersion("missing.dataset")).toBeNull()
          expect(await storage.getVersion(writeDataset.id, missingVersionId)).toBeNull()
        })
      })

      test("snapshot writes replace the visible latest rows", async () => {
        await withStorage(async (storage) => {
          await storage.createDataset(writeDataset)

          const firstWrite = await storage.beginWrite({ dataset: writeDataset, mode: "snapshot" })
          await firstWrite.writeRows([{ orderId: "ord_1", customerName: "Ada" }])
          const firstVersion = await firstWrite.commit()

          const replacementWrite = await storage.beginWrite({
            dataset: writeDataset,
            mode: "snapshot",
          })
          await replacementWrite.writeRows([{ orderId: "ord_9", customerName: "Dorothy" }])
          const replacementVersion = await replacementWrite.commit()

          expect(replacementVersion.versionId).not.toBe(firstVersion.versionId)
          expect(replacementVersion.parentVersionId).toBeUndefined()
          expect(replacementVersion.rowCount).toBe(1)
          await expect(
            collectRows(storage.readRows({ datasetId: writeDataset.id }))
          ).resolves.toEqual([{ orderId: "ord_9", customerName: "Dorothy" }])
          await expect(
            collectRows(
              storage.readRows({ datasetId: writeDataset.id, versionId: firstVersion.versionId })
            )
          ).resolves.toEqual([{ orderId: "ord_1", customerName: "Ada" }])
        })
      })

      test("fails stale optimistic commits", async () => {
        await withStorage(async (storage) => {
          await storage.createDataset(writeDataset)

          const seedWrite = await storage.beginWrite({ dataset: writeDataset, mode: "snapshot" })
          await seedWrite.writeRows([{ orderId: "ord_1", customerName: "Ada" }])
          const initialVersion = await seedWrite.commit()

          const delayedWrite = await storage.beginWrite({ dataset: writeDataset, mode: "append" })
          await delayedWrite.writeRows([{ orderId: "ord_2", customerName: "Grace" }])

          const competingWrite = await storage.beginWrite({
            dataset: writeDataset,
            mode: "append",
          })
          await competingWrite.writeRows([{ orderId: "ord_3", customerName: "Katherine" }])
          await competingWrite.commit({ expectedLatestVersionId: initialVersion.versionId })

          await expect(
            delayedWrite.commit({ expectedLatestVersionId: initialVersion.versionId })
          ).rejects.toThrow("Optimistic commit failed")
          await expect(
            collectRows(storage.readRows({ datasetId: writeDataset.id }))
          ).resolves.toEqual([
            { orderId: "ord_1", customerName: "Ada" },
            { orderId: "ord_3", customerName: "Katherine" },
          ])
        })
      })

      test("abort closes a write session without committing rows", async () => {
        await withStorage(async (storage) => {
          await storage.createDataset(writeDataset)

          const write = await storage.beginWrite({ dataset: writeDataset, mode: "snapshot" })
          await write.writeRows([{ orderId: "ord_1", customerName: "Ada" }])
          await write.abort()
          await write.abort()

          expect(await storage.getLatestVersion(writeDataset.id)).toBeNull()
          expect(await storage.listVersions(writeDataset.id)).toEqual([])
          await expect(
            collectRows(storage.readRows({ datasetId: writeDataset.id }))
          ).rejects.toThrow("No committed version found")
        })
      })

      test("commit closes a write session and leaves abort idempotent", async () => {
        await withStorage(async (storage) => {
          await storage.createDataset(writeDataset)

          const write = await storage.beginWrite({ dataset: writeDataset, mode: "snapshot" })
          await write.writeRows([{ orderId: "ord_1", customerName: "Ada" }])
          await write.commit()
          await write.abort()

          await expect(write.writeRows([])).rejects.toThrow("already closed")
        })
      })

      test("rejects rows that do not match the dataset schema", async () => {
        await withStorage(async (storage) => {
          await storage.createDataset(writeDataset)
          const write = await storage.beginWrite({ dataset: writeDataset, mode: "snapshot" })

          await expect(write.writeRows([{ orderId: "ord_1" }])).rejects.toThrow(
            "missing required column"
          )
          await expect(
            write.writeRows([{ orderId: "ord_1", customerName: "Ada", unexpected: true } as never])
          ).rejects.toThrow("unknown column")
          await write.abort()
        })
      })

      test("round-trips fileRef row values", async () => {
        await withStorage(async (storage) => {
          await storage.createDataset(fileRefDataset)

          const write = await storage.beginWrite({ dataset: fileRefDataset, mode: "snapshot" })
          await write.writeRows([
            { id: "doc_1", attachment: invoiceRef },
            { id: "doc_2", attachment: null },
          ])
          await write.commit()

          await expect(
            collectRows(storage.readRows({ datasetId: fileRefDataset.id }))
          ).resolves.toEqual([
            { id: "doc_1", attachment: invoiceRef },
            { id: "doc_2", attachment: null },
          ])
        })
      })
    })
  })
}

async function collectRows(rows: AsyncIterable<DatasetRow>): Promise<DatasetRow[]> {
  const result: DatasetRow[] = []
  for await (const row of rows) {
    result.push(row)
  }
  return result
}
