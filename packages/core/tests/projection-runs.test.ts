import { InMemoryStorage } from "../src/storage"
import { runProjectionRunStorageContractSuite } from "../src/testing"

runProjectionRunStorageContractSuite("InMemoryProjectionRunStorage", {
  createStorage: () => {
    const storage = new InMemoryStorage()
    return { projectionRuns: storage.projectionRuns, executions: storage.executions }
  },
})
