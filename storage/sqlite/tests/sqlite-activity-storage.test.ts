import type { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { runActivityStorageContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"

runActivityStorageContractSuite("SqliteActivityStorage", {
  createStorage: () => new SqliteStorage(),
  cleanup: (storage) => storage.close(),
  deleteVisit: async (storage, visit) => {
    database(storage)
      .query("DELETE FROM activity_visits WHERE project_id = ? AND id = ?")
      .run(visit.projectId, visit.id)
  },
})

function database(storage: SqliteStorage): Database {
  return (storage as unknown as { connection: { db: Database } }).connection.db
}

describe("SqliteStorage activity integration", () => {
  // A later change joins visits with the execution ledger by session id: a hash would not join.
  test("keeps the session id itself on the source and the visit", async () => {
    const storage = new SqliteStorage()
    try {
      await storage.activity.append({
        projectId: "p",
        actor: { type: "user", userId: "user-a" },
        sessionId: "ses_1",
        events: [
          { id: "view", type: "page.view", route: "/" },
          { id: "click", type: "ui.interaction", name: "home.open", route: "/" },
        ],
        now: new Date("2026-10-01T12:00:00.000Z"),
        idleTimeoutMs: 30 * 60_000,
        newVisitId: "visit-1",
      })

      const db = database(storage)
      expect(db.query("SELECT session_id FROM activity_visits").all()).toEqual([
        { session_id: "ses_1" },
      ])
      expect(db.query("SELECT actor_type, session_id FROM activity_sources").all()).toEqual([
        { actor_type: "user", session_id: "ses_1" },
      ])

      // One user's history is removable: their page views and interactions go with their visits.
      db.run("DELETE FROM activity_visits WHERE project_id = 'p' AND user_id = 'user-a'")
      expect(db.query("SELECT COUNT(*) AS count FROM activity_page_views").get()).toEqual({
        count: 0,
      })
      expect(db.query("SELECT COUNT(*) AS count FROM activity_interactions").get()).toEqual({
        count: 0,
      })
    } finally {
      storage.close()
    }
  })
})
