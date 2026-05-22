import { describe, expect, test } from "bun:test"
import { InMemoryAuthStorage, InMemoryStorage } from "../src"
import { runAuthStorageContractSuite } from "../src/testing"

runAuthStorageContractSuite("InMemoryAuthStorage", {
  createStorage: () => new InMemoryAuthStorage(),
})

describe("InMemoryStorage auth", () => {
  test("exposes auth storage", async () => {
    const storage = new InMemoryStorage()

    await expect(
      storage.auth.users.create({
        id: "usr_1",
        projectId: "project-a",
        email: "ava@acme.com",
      })
    ).resolves.toMatchObject({
      id: "usr_1",
      email: "ava@acme.com",
    })
  })
})
