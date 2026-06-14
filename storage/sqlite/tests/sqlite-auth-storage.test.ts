import { describe, expect, test } from "bun:test"
import { runAuthStorageContractSuite } from "@sixb/core/testing"
import { SqliteAuthStorage, SqliteStorage } from "../src"

runAuthStorageContractSuite("SqliteAuthStorage", {
  createStorage: () => new SqliteAuthStorage(),
  teardown: (storage) => {
    storage.close()
  },
})

describe("SqliteStorage auth", () => {
  test("filters invitations by group ids with pagination metadata", async () => {
    const auth = new SqliteAuthStorage()

    try {
      await auth.invitations.createOrUpdateActive({
        id: "inv_commercial",
        projectId: "project-a",
        email: "commercial@acme.com",
        groupIds: ["commercial"],
        createdAt: new Date("2026-05-14T10:00:00.000Z"),
        expiresAt: new Date("2026-05-21T10:00:00.000Z"),
      })
      await auth.invitations.createOrUpdateActive({
        id: "inv_finance",
        projectId: "project-a",
        email: "finance@acme.com",
        groupIds: ["finance"],
        createdAt: new Date("2026-05-14T10:01:00.000Z"),
        expiresAt: new Date("2026-05-21T10:01:00.000Z"),
      })
      await auth.invitations.createOrUpdateActive({
        id: "inv_empty",
        projectId: "project-a",
        email: "empty@acme.com",
        createdAt: new Date("2026-05-14T10:02:00.000Z"),
        expiresAt: new Date("2026-05-21T10:02:00.000Z"),
      })

      const firstPage = await auth.invitations.list({
        projectId: "project-a",
        groupIds: ["commercial", "finance"],
        order: "asc",
        limit: 1,
      })

      expect(firstPage.total).toBe(2)
      expect(firstPage.hasMore).toBe(true)
      expect(firstPage.invitations.map((invitation) => invitation.id)).toEqual(["inv_commercial"])

      const finance = await auth.invitations.list({
        projectId: "project-a",
        groupIds: ["finance"],
      })

      expect(finance.invitations.map((invitation) => invitation.id)).toEqual(["inv_finance"])
    } finally {
      auth.close()
    }
  })

  test("exposes auth storage", async () => {
    const storage = new SqliteStorage()

    try {
      expect(storage.auth).toBeInstanceOf(SqliteAuthStorage)

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
    } finally {
      closeSqliteStorage(storage)
    }
  })
})

function closeSqliteStorage(storage: SqliteStorage): void {
  storage.objects.close()
  storage.auth.close()
  storage.actionRuns.close()
  storage.edits.close()
  storage.pipelineRuns.close()
  storage.projectionRuns.close()
  storage.workflowRuns.close()
  storage.syncRuns.close()
  storage.timeseries.close()
  storage.webhookDeliveries.close()
  storage.webhookRuns.close()
  storage.rules.close()
}
