import type { FileUploadSessionStore } from "@sixb/core/storage"
import { runFileUploadSessionStorageContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"

const storages = new Map<FileUploadSessionStore, SqliteStorage>()

runFileUploadSessionStorageContractSuite("SqliteFileUploadSessionStorage", {
  createStorage: () => {
    const storage = new SqliteStorage()
    storages.set(storage.fileUploadSessions, storage)
    return storage.fileUploadSessions
  },
  cleanup: (fileUploadSessions) => {
    storages.get(fileUploadSessions)?.close()
    storages.delete(fileUploadSessions)
  },
})
