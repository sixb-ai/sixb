import { describe, expect, test } from "bun:test"
import { InMemoryStorage } from "../src/storage"
import { InMemoryShareGrantStorage } from "../src/storage/share-grants"
import { InMemoryShareSessionStorage } from "../src/storage/share-sessions"
import { parseShareSessionRecord } from "../src/storage/share-sessions/provider"
import {
  createShareGrantStorageContractInput,
  createShareSessionStorageContractInput,
  runShareSessionStorageContractSuite,
} from "../src/testing"

runShareSessionStorageContractSuite("InMemoryShareSessionStorage", {
  createStorage: createSessionStorage,
})

describe("Share session storage integration", () => {
  test("fails closed when a durable row is corrupt", async () => {
    const storage = await createSessionStorage()
    const created = await storage.create(createShareSessionStorageContractInput())
    expect(() => parseShareSessionRecord({ ...created, tokenHash: "not-a-hash" })).toThrow(
      expect.objectContaining({ code: "invalid_record" })
    )
    expect(() =>
      parseShareSessionRecord({
        ...created,
        absoluteExpiresAt: new Date("2026-08-20T12:04:00.000Z"),
      })
    ).toThrow(expect.objectContaining({ code: "invalid_record" }))
  })

  test("participates in InMemoryStorage commit and rollback", async () => {
    const storage = new InMemoryStorage()
    await storage.transaction(async (tx) => {
      await tx.shareGrants?.create(grantInput("share-session-contract"))
      await tx.shareSessions?.create(createShareSessionStorageContractInput())
    })
    await expect(
      storage.shareSessions.getById({ projectId: "share-session-contract", id: "shs_1" })
    ).resolves.toMatchObject({ id: "shs_1" })

    await expect(
      storage.transaction(async (tx) => {
        await tx.shareSessions?.create(
          createShareSessionStorageContractInput({
            id: "shs_rollback",
            tokenHash: "b".repeat(64),
          })
        )
        throw new Error("rollback")
      })
    ).rejects.toThrow("rollback")
    await expect(
      storage.shareSessions.getById({
        projectId: "share-session-contract",
        id: "shs_rollback",
      })
    ).resolves.toBeNull()
  })
})

async function createSessionStorage(): Promise<InMemoryShareSessionStorage> {
  const grants = new InMemoryShareGrantStorage()
  await grants.create(grantInput("share-session-contract"))
  await grants.create(grantInput("other-project"))
  return new InMemoryShareSessionStorage(grants)
}

function grantInput(projectId: string) {
  return createShareGrantStorageContractInput({
    projectId,
    id: "shr_1",
    expiresAt: new Date("2026-08-21T12:00:00.000Z"),
  })
}
