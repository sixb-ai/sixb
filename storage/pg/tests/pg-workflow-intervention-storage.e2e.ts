import type { WorkflowInterventionStorage } from "@sixb/core/storage"
import { runWorkflowInterventionStorageContractSuite } from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import { createTestStorage, disposeTestStorage } from "./helpers"

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
    await disposeTestStorage(storage)
  },
})
