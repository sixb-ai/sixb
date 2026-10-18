import { InMemoryWorkflowInterventionStorage } from "../src/storage"
import { runWorkflowInterventionStorageContractSuite } from "../src/testing"

runWorkflowInterventionStorageContractSuite("InMemoryWorkflowInterventionStorage", {
  createStorage: () => new InMemoryWorkflowInterventionStorage(),
})
