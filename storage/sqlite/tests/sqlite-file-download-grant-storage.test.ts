import type { FileDownloadGrantStorage } from "@sixb/core/storage"
import { runFileDownloadGrantStorageContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"

const storages = new Map<FileDownloadGrantStorage, SqliteStorage>()

runFileDownloadGrantStorageContractSuite("SqliteFileDownloadGrantStorage", {
  createStorage: () => {
    const storage = new SqliteStorage()
    storages.set(storage.fileDownloadGrants, storage)
    return storage.fileDownloadGrants
  },
  cleanup: (fileDownloadGrants) => {
    storages.get(fileDownloadGrants)?.close()
    storages.delete(fileDownloadGrants)
  },
})
