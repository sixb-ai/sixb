import { describe, expect, test } from "bun:test"
import { InMemoryStorage } from "../src/storage"
import { InMemoryShareGrantStorage } from "../src/storage/share-grants"
import { parseShareGrantRecord } from "../src/storage/share-grants/provider"
import {
  createShareGrantStorageContractInput,
  runShareGrantStorageContractSuite,
} from "../src/testing"

runShareGrantStorageContractSuite("InMemoryShareGrantStorage", {
  createStorage: () => new InMemoryShareGrantStorage(),
})

describe("Share grant storage integration", () => {
  test("fails closed when a durable authority digest or version is corrupt", async () => {
    const storage = new InMemoryShareGrantStorage()
    const created = await storage.create(createShareGrantStorageContractInput())

    expect(() => parseShareGrantRecord({ ...created, authorityDigest: "0".repeat(64) })).toThrow(
      expect.objectContaining({ code: "invalid_record" })
    )
    expect(() =>
      parseShareGrantRecord({
        ...created,
        authoritySnapshot: { ...created.authoritySnapshot, version: 2 },
      })
    ).toThrow(expect.objectContaining({ code: "invalid_record" }))
    expect(() =>
      parseShareGrantRecord({
        ...created,
        authoritySnapshot: { version: 1, access: { grants: [{ kind: "object.view" }] } },
      })
    ).toThrow(expect.objectContaining({ code: "invalid_record" }))
  })

  test("participates in InMemoryStorage commit and rollback", async () => {
    const storage = new InMemoryStorage()
    await storage.transaction(async (tx) => {
      await tx.shareGrants?.create(createShareGrantStorageContractInput())
    })
    await expect(
      storage.shareGrants.getById({ projectId: "share-grant-contract", id: "shr_1" })
    ).resolves.toMatchObject({ id: "shr_1" })

    await expect(
      storage.transaction(async (tx) => {
        await tx.shareGrants?.create(
          createShareGrantStorageContractInput({ id: "shr_rollback", tokenHash: "b".repeat(64) })
        )
        throw new Error("rollback")
      })
    ).rejects.toThrow("rollback")
    await expect(
      storage.shareGrants.getById({
        projectId: "share-grant-contract",
        id: "shr_rollback",
      })
    ).resolves.toBeNull()
  })

  test("rejects root Share storage inside a transaction", async () => {
    const storage = new InMemoryStorage()
    await expect(
      storage.transaction(async () => {
        await storage.shareGrants.getById({
          projectId: "share-grant-contract",
          id: "shr_1",
        })
      })
    ).rejects.toThrow("use the provided tx storage")
  })
})
