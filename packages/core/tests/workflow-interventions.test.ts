import { expect, test } from "bun:test"
import { InMemoryStorage } from "../src"
import { InMemoryWorkflowInterventionStorage } from "../src/storage"
import { runWorkflowInterventionStorageContractSuite } from "../src/testing"

runWorkflowInterventionStorageContractSuite("InMemoryWorkflowInterventionStorage", {
  createStorage: () => new InMemoryWorkflowInterventionStorage(),
})

test("InMemoryStorage includes workflow intervention storage", () => {
  const storage = new InMemoryStorage()
  expect(storage.workflowInterventions).toBeInstanceOf(InMemoryWorkflowInterventionStorage)
})
