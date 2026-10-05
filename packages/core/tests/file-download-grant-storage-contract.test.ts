import { InMemoryFileDownloadGrantStorage } from "../src/storage/file-download-grants"
import { runFileDownloadGrantStorageContractSuite } from "../src/testing"

runFileDownloadGrantStorageContractSuite("InMemoryFileDownloadGrantStorage", {
  createStorage: () => new InMemoryFileDownloadGrantStorage(),
})
