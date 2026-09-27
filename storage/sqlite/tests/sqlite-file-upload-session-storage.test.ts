import { expect, test } from "bun:test"
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

// Reproduce the failure by dropping `async` from `DurableFileUploadSessions.abort`: the facade
// then passes the call through unlocked, it joins the open transaction, and the rollback undoes it.
test("a transition waits for an open storage transaction instead of joining it", async () => {
  const storage = new SqliteStorage()
  try {
    const principal = { type: "user", id: "usr_owner" } as const
    await storage.fileUploadSessions.create({
      id: "upload_isolated",
      projectId: "file-upload-isolation",
      principal,
      strategy: "server",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })

    let started!: () => void
    const opened = new Promise<void>((resolve) => {
      started = resolve
    })
    const rolledBack = storage
      .transaction(async () => {
        started()
        await Bun.sleep(20)
        throw new Error("rollback")
      })
      .catch(() => undefined)
    await opened

    await storage.fileUploadSessions.abort("upload_isolated")
    await rolledBack

    const session = await storage.fileUploadSessions.getForPrincipal("upload_isolated", principal)
    expect(session.status).toBe("aborted")
  } finally {
    storage.close()
  }
})
