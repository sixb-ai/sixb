import { InMemoryFileUploadSessions } from "../src/storage"
import { runFileUploadSessionStorageContractSuite } from "../src/testing"

runFileUploadSessionStorageContractSuite("InMemoryFileUploadSessions", {
  createStorage: () => new InMemoryFileUploadSessions(),
})
