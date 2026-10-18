import { describe, expect, test } from "bun:test"
import { createTestAgentExecution, runAgentStorageContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"

runAgentStorageContractSuite("SqliteAgentStorage", {
  createStorage: () => new SqliteStorage(),
  teardown: (storage) => {
    storage.close()
  },
})

describe("SqliteStorage agents", () => {
  test("rolls back agent writes when a transaction throws", async () => {
    const storage = new SqliteStorage()

    try {
      await storage.agents.threads.create({
        id: "thr_1",
        projectId: "p",
        ownerPrincipal: { type: "user", id: "usr_1" },
        createdAt: new Date("2026-06-23T10:00:00.000Z"),
      })

      await expect(
        storage.transaction(async (tx) => {
          if (!tx.auth) throw new Error("expected auth storage")
          const executionId = await createTestAgentExecution(
            { auth: tx.auth, executions: tx.executions },
            { projectId: "p", runId: "run_1", authority: "inherited" }
          )
          await tx.agents?.runs.create({
            id: "run_1",
            projectId: "p",
            executionId,
            threadId: "thr_1",
            triggerMessageId: "msg_1",
            spec: { model: { provider: "test", modelId: "test-model" } },
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

      // Nothing partial survived: no execution, run, message, or thread mutation.
      expect(
        await storage.executions.getById({ projectId: "p", id: "test_agent_execution:run_1" })
      ).toBeNull()
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
