import { describe, expect, test } from "bun:test"
import { runActivityStorageContractSuite } from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import type { SQL } from "../src/pg-client"
import { createTestStorage } from "./helpers"

runActivityStorageContractSuite<PostgresStorage>("PgActivityStorage", {
  createStorage: async () => (await createTestStorage()).storage,
  cleanup: async (storage) => {
    await storage.dropSchema()
    await storage.close()
  },
  deleteVisit: async (storage, visit) => {
    await sqlOf(storage)`
      DELETE FROM activity_visits WHERE project_id = ${visit.projectId} AND id = ${visit.id}
    `
  },
})

function sqlOf(storage: PostgresStorage): SQL {
  return (storage as unknown as { sql: SQL }).sql
}

describe("Postgres activity integration", () => {
  // A later change joins visits with the execution ledger by session id: a hash would not join.
  test("keeps the session id itself on the source and the visit", async () => {
    const { storage } = await createTestStorage()
    try {
      await storage.activity.append({
        projectId: "p",
        actor: { type: "share", grantId: "shr_1" },
        sessionId: "shs_1",
        events: [{ id: "view", type: "page.view", route: "/" }],
        now: new Date("2026-10-01T12:00:00.000Z"),
        idleTimeoutMs: 30 * 60_000,
        newVisitId: "visit-1",
      })

      const sql = sqlOf(storage)
      expect([...(await sql`SELECT session_id FROM activity_visits`)]).toEqual([
        { session_id: "shs_1" },
      ])
    } finally {
      await storage.dropSchema()
      await storage.close()
    }
  })
})
