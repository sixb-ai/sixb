import type { FileUploadSessionStore } from "@sixb/core/storage"
import { runFileUploadSessionStorageContractSuite } from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import { createTestStorage } from "./helpers"

const storages = new Map<FileUploadSessionStore, PostgresStorage>()

runFileUploadSessionStorageContractSuite("PgFileUploadSessionStorage", {
  createStorage: async () => {
    const { storage } = await createTestStorage()
    storages.set(storage.fileUploadSessions, storage)
    return storage.fileUploadSessions
  },
  cleanup: async (fileUploadSessions) => {
    const storage = storages.get(fileUploadSessions)
    if (!storage) return
    storages.delete(fileUploadSessions)
    await storage.dropSchema()
    await storage.close()
  },
})
