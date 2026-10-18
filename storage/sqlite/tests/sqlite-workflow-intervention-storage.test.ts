import { runWorkflowInterventionStorageContractSuite } from "@sixb/core/testing"
import { SqliteWorkflowInterventionStorage } from "../src/workflow-intervention-storage"

runWorkflowInterventionStorageContractSuite("SqliteWorkflowInterventionStorage", {
  createStorage: () => new SqliteWorkflowInterventionStorage(),
  cleanup: (storage) => storage.close(),
})
