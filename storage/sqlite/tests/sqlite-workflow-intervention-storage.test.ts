import { expect, test } from "bun:test"
import { runWorkflowInterventionStorageContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"
import { SqliteWorkflowInterventionStorage } from "../src/workflow-intervention-storage"

runWorkflowInterventionStorageContractSuite("SqliteWorkflowInterventionStorage", {
  createStorage: () => new SqliteWorkflowInterventionStorage(),
  cleanup: (storage) => storage.close(),
})

test("SqliteStorage includes workflow intervention storage", () => {
  const storage = new SqliteStorage()
  try {
    expect(storage.workflowInterventions).toBeInstanceOf(SqliteWorkflowInterventionStorage)
  } finally {
    storage.close()
  }
})
