import { describe, expect, test } from "bun:test"
import { runAuthStorageContractSuite } from "@pario/core/testing"
import type { PostgresStorage } from "../src"
import { PgAuthStorage } from "../src"
import { createTestStorage } from "./helpers"

const owners = new WeakMap<PgAuthStorage, PostgresStorage>()

runAuthStorageContractSuite("PgAuthStorage", {
  createStorage: async () => {
    const { storage } = await createTestStorage()
    owners.set(storage.auth, storage)
    return storage.auth
  },
  teardown: async (auth) => {
    const storage = owners.get(auth)
    if (!storage) return

    await storage.dropSchema()
    await storage.close()
  },
})

describe("PostgresStorage auth", () => {
  test("filters invitations by group ids with pagination metadata", async () => {
    await withStorage(async (storage) => {
      await storage.auth.invitations.createOrUpdateActive({
        id: "inv_commercial",
        projectId: "project-a",
        email: "commercial@acme.com",
        groupIds: ["commercial"],
        createdAt: new Date("2026-05-14T10:00:00.000Z"),
        expiresAt: new Date("2026-05-21T10:00:00.000Z"),
      })
      await storage.auth.invitations.createOrUpdateActive({
        id: "inv_finance",
        projectId: "project-a",
        email: "finance@acme.com",
        groupIds: ["finance"],
        createdAt: new Date("2026-05-14T10:01:00.000Z"),
        expiresAt: new Date("2026-05-21T10:01:00.000Z"),
      })
      await storage.auth.invitations.createOrUpdateActive({
        id: "inv_empty",
        projectId: "project-a",
        email: "empty@acme.com",
        createdAt: new Date("2026-05-14T10:02:00.000Z"),
        expiresAt: new Date("2026-05-21T10:02:00.000Z"),
      })

      const firstPage = await storage.auth.invitations.list({
        projectId: "project-a",
        groupIds: ["commercial", "finance"],
        order: "asc",
        limit: 1,
      })

      expect(firstPage.total).toBe(2)
      expect(firstPage.hasMore).toBe(true)
      expect(firstPage.invitations.map((invitation) => invitation.id)).toEqual(["inv_commercial"])

      const finance = await storage.auth.invitations.list({
        projectId: "project-a",
        groupIds: ["finance"],
      })

      expect(finance.invitations.map((invitation) => invitation.id)).toEqual(["inv_finance"])
    })
  })

  test("exposes auth storage", async () => {
    await withStorage(async (storage) => {
      expect(storage.auth).toBeInstanceOf(PgAuthStorage)

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

  test("keeps one active magic link under concurrent creation", async () => {
    await withStorage(async (storage) => {
      await Promise.all([
        storage.auth.magicLinks.create({
          id: "ml_1",
          projectId: "project-a",
          strategyId: "magic-link",
          audience: "admin",
          email: "ava@acme.com",
          tokenHash: "hash-1",
          createdAt: new Date("2026-05-14T10:00:00.000Z"),
          expiresAt: new Date("2026-05-14T10:15:00.000Z"),
        }),
        storage.auth.magicLinks.create({
          id: "ml_2",
          projectId: "project-a",
          strategyId: "magic-link",
          audience: "admin",
          email: "ava@acme.com",
          tokenHash: "hash-2",
          createdAt: new Date("2026-05-14T10:00:00.000Z"),
          expiresAt: new Date("2026-05-14T10:15:00.000Z"),
        }),
      ])

      const links = await Promise.all([
        storage.auth.magicLinks.getById({ projectId: "project-a", id: "ml_1" }),
        storage.auth.magicLinks.getById({ projectId: "project-a", id: "ml_2" }),
      ])

      expect(links.filter((link) => link && !link.revokedAt && !link.consumedAt)).toHaveLength(1)
    })
  })
})

async function withStorage(run: (storage: PostgresStorage) => Promise<void>): Promise<void> {
  const { storage } = await createTestStorage()

  try {
    await run(storage)
  } finally {
    await storage.dropSchema()
    await storage.close()
  }
}
