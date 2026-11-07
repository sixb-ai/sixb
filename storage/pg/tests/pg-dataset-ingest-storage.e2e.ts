import { expect, test } from "bun:test"
import type { DatasetIngestStorage } from "@sixb/core/storage"
import { runDatasetIngestStorageContractSuite } from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import { createPgClient } from "../src/pg-client"
import { runPgTransaction } from "../src/transactions"
import { createTestStorage, disposeTestStorage, waitForLockWait } from "./helpers"

const storages = new Map<DatasetIngestStorage, PostgresStorage>()

runDatasetIngestStorageContractSuite("PgDatasetIngestStorage", {
  createStorage: async () => {
    const { storage } = await createTestStorage()
    storages.set(storage.datasetIngest, storage)
    return storage.datasetIngest
  },
  cleanup: async (datasetIngest) => {
    const storage = storages.get(datasetIngest)
    if (!storage) return
    storages.delete(datasetIngest)
    await disposeTestStorage(storage)
  },
})

const projectId = "dataset-ingest-race"
const datasetId = "crm.people"

test("a delivery waits for a batch closing the request it would have joined", async () => {
  // Regression proof: drop `FOR UPDATE` from `lockState` in pg-dataset-ingest-storage.ts. The
  // delivery then reads the request still open, joins it, and waits with no flush.
  const { storage, schemaName, connectionString } = await createTestStorage()
  const holder = createPgClient({ connectionString, schemaName, max: 1 })
  const inbox = storage.datasetIngest

  try {
    expect((await inbox.append(delivery("1"))).flush.requested).toBe(true)

    // A batch that has locked the state row and read the deliveries committed so far.
    let lockHeld!: () => void
    let closeRequest!: () => void
    const locked = new Promise<void>((resolve) => (lockHeld = resolve))
    const closing = new Promise<void>((resolve) => (closeRequest = resolve))
    const batch = runPgTransaction(holder, async (sql) => {
      await sql`
        SELECT 1 FROM dataset_ingest_state
        WHERE project_id = ${projectId} AND dataset_id = ${datasetId}
        FOR UPDATE
      `
      lockHeld()
      await closing
      await sql`
        UPDATE dataset_ingest_state SET requested = FALSE, request = request + 1
        WHERE project_id = ${projectId} AND dataset_id = ${datasetId}
      `
    })
    await locked

    // A delivery stored after the batch read: its request waits for the batch.
    const asking = inbox.append(delivery("2"))
    await waitForLockWait(connectionString, asking)

    closeRequest()
    await batch

    expect((await asking).flush).toEqual({ request: 1, requested: true })
  } finally {
    await holder.end()
    await disposeTestStorage(storage)
  }
})

function delivery(id: string) {
  return {
    projectId,
    datasetId,
    executionId: "exec-1",
    correlationId: "corr-1",
    changes: [{ kind: "upsert" as const, row: { id } }],
  }
}
