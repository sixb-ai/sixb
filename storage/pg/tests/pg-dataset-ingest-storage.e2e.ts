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
        UPDATE dataset_ingest_state SET requested_at = NULL, request = request + 1
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

// Reproduce: make `id` the whole primary key in the migration. With one dataset's backlog ahead of
// another's, the planner then walks that key past the first to read the second.
test("the deliveries' primary key leads with the dataset", async () => {
  const { storage, schemaName, connectionString } = await createTestStorage()
  const client = createPgClient({ connectionString, schemaName, max: 1 })

  try {
    const [row] = await client<{ readonly definition: string }[]>`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'dataset_ingest_deliveries'::regclass AND contype = 'p'
    `

    expect(row?.definition).toBe("PRIMARY KEY (project_id, dataset_id, id)")
  } finally {
    await client.end()
    await disposeTestStorage(storage)
  }
})

function delivery(id: string) {
  return {
    projectId,
    datasetId,
    executionId: "exec-1",
    correlationId: "corr-1",
    definitionHash: "definition-1",
    changes: [{ kind: "upsert" as const, row: { id } }],
  }
}
