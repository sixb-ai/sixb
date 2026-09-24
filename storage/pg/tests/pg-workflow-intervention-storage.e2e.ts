import { expect, test } from "bun:test"
import type { WorkflowInterventionStorage } from "@sixb/core/storage"
import { runWorkflowInterventionStorageContractSuite } from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import { PgWorkflowInterventionStorage } from "../src/pg-workflow-intervention-storage"
import { createTestStorage } from "./helpers"

const storages = new Map<WorkflowInterventionStorage, PostgresStorage>()

runWorkflowInterventionStorageContractSuite("PgWorkflowInterventionStorage", {
  createStorage: async () => {
    const { storage } = await createTestStorage()
    storages.set(storage.workflowInterventions, storage)
    return storage.workflowInterventions
  },
  cleanup: async (workflowInterventions) => {
    const storage = storages.get(workflowInterventions)
    if (!storage) return
    storages.delete(workflowInterventions)
    await storage.dropSchema()
    await storage.close()
  },
})

test("PostgresStorage includes workflow intervention storage", async () => {
  const { storage } = await createTestStorage()
  try {
    expect(storage.workflowInterventions).toBeInstanceOf(PgWorkflowInterventionStorage)
  } finally {
    await storage.dropSchema()
    await storage.close()
  }
})
