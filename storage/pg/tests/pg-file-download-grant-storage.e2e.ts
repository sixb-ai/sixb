import type { FileDownloadGrantStorage } from "@sixb/core/storage"
import { runFileDownloadGrantStorageContractSuite } from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import { createTestStorage, disposeTestStorage } from "./helpers"

const storages = new Map<FileDownloadGrantStorage, PostgresStorage>()

runFileDownloadGrantStorageContractSuite("PgFileDownloadGrantStorage", {
  createStorage: async () => {
    const { storage } = await createTestStorage()
    storages.set(storage.fileDownloadGrants, storage)
    return storage.fileDownloadGrants
  },
  cleanup: async (fileDownloadGrants) => {
    const storage = storages.get(fileDownloadGrants)
    if (!storage) return
    storages.delete(fileDownloadGrants)
    await disposeTestStorage(storage)
  },
})
