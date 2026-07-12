import { describe, expect, test } from "bun:test"
import { runAgentStorageContractSuite } from "@sixb/core/testing"
import { SqliteAgentStorage, SqliteStorage } from "../src"

runAgentStorageContractSuite("SqliteAgentStorage", {
  createStorage: () => new SqliteAgentStorage(),
  teardown: (storage) => {
    storage.close()
  },
})

describe("SqliteStorage agents", () => {
  test("is bundled into the composite storage", async () => {
    const storage = new SqliteStorage()

    try {
      expect(storage.agents).toBeInstanceOf(SqliteAgentStorage)

      await storage.agents.threads.create({
        id: "thr_1",
        projectId: "p",
        agentId: "sales",
        ownerPrincipal: { type: "user", id: "usr_1" },
        createdAt: new Date("2026-06-23T10:00:00.000Z"),
      })
      await expect(
        storage.agents.threads.getById({ projectId: "p", id: "thr_1" })
      ).resolves.toMatchObject({ id: "thr_1", activeRunId: null, messageCount: 0 })
    } finally {
      storage.close()
    }
  })

  test("rolls back agent writes when a transaction throws", async () => {
    const storage = new SqliteStorage()

    try {
      await storage.agents.threads.create({
        id: "thr_1",
        projectId: "p",
        agentId: "sales",
        ownerPrincipal: { type: "user", id: "usr_1" },
        createdAt: new Date("2026-06-23T10:00:00.000Z"),
      })

      await expect(
        storage.transaction(async (tx) => {
          await tx.agents?.runs.create({
            id: "run_1",
            projectId: "p",
            threadId: "thr_1",
            agentId: "sales",
            triggerMessageId: "msg_1",
            requestedByPrincipal: { type: "user", id: "usr_1" },
            createdAt: new Date("2026-06-23T10:00:10.000Z"),
          })
          await tx.agents?.messages.append({
            id: "msg_asst_1",
            projectId: "p",
            threadId: "thr_1",
            runId: "run_1",
            role: "assistant",
            parts: [{ type: "text", text: "partial" }],
          })
          throw new Error("boom")
        })
      ).rejects.toThrow("boom")

      // Nothing partial survived: no run, no message, thread anchor + stats untouched.
      expect(await storage.agents.runs.getById({ projectId: "p", id: "run_1" })).toBeNull()
      expect(await storage.agents.messages.getById({ projectId: "p", id: "msg_asst_1" })).toBeNull()
      await expect(
        storage.agents.threads.getById({ projectId: "p", id: "thr_1" })
      ).resolves.toMatchObject({ activeRunId: null, messageCount: 0 })
    } finally {
      storage.close()
    }
  })
})
