import { describe, expect, test } from "bun:test"
import { type AuthUserHold, runAuthStorageContractSuite } from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import type { PgAuthStorage } from "../src/auth-storage"
import { createPgClient } from "../src/pg-client"
import { createTestStorage, disposeTestStorage, type TestStorage, waitForLockWait } from "./helpers"

const owners = new WeakMap<PgAuthStorage, TestStorage>()

runAuthStorageContractSuite("PgAuthStorage", {
  createStorage: async () => {
    const created = await createTestStorage()
    owners.set(created.storage.auth, created)
    return created.storage.auth
  },
  teardown: async (auth) => {
    const created = owners.get(auth)
    if (!created) return

    await disposeTestStorage(created.storage)
  },
  holdUser: async (auth, user) => {
    const created = owners.get(auth)
    if (!created) throw new Error("Expected a test storage.")

    return holdUserRow(created, user)
  },
})

/** Locks the user's row in a transaction of its own, open until `release`. */
async function holdUserRow(
  { connectionString, schemaName }: TestStorage,
  user: { readonly projectId: string; readonly id: string }
): Promise<AuthUserHold> {
  const sql = createPgClient({ connectionString, schemaName, max: 1 })
  const { promise: released, resolve: release } = Promise.withResolvers<void>()
  const { promise: locked, resolve: lock } = Promise.withResolvers<void>()

  const holding = sql.begin(async (tx) => {
    await tx`
      SELECT id FROM auth_users
      WHERE project_id = ${user.projectId} AND id = ${user.id}
      FOR UPDATE
    `
    lock()
    await released
  })
  await Promise.race([locked, holding])

  return {
    waitForWaiters: (count, competing) => waitForLockWait(connectionString, competing, count),
    release: async () => {
      release()
      await holding
      await sql.end()
    },
  }
}

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

  test("keeps one active magic link under concurrent creation", async () => {
    await withStorage(async (storage) => {
      await Promise.all([
        storage.auth.magicLinks.create({
          id: "ml_1",
          projectId: "project-a",
          strategyId: "magic-link",
          email: "ava@acme.com",
          tokenHash: "hash-1",
          createdAt: new Date("2026-05-14T10:00:00.000Z"),
          expiresAt: new Date("2026-05-14T10:15:00.000Z"),
        }),
        storage.auth.magicLinks.create({
          id: "ml_2",
          projectId: "project-a",
          strategyId: "magic-link",
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
    await disposeTestStorage(storage)
  }
}
