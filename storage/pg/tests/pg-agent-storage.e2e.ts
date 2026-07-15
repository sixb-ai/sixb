import { describe, expect, test } from "bun:test"
import type { AgentStorage } from "@sixb/core/storage"
import { runAgentStorageContractSuite } from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import { PgAgentStorage } from "../src/agents"
import { createTestStorage } from "./helpers"

// Each contract case gets its own throwaway schema; map the returned sub-store back to its bundle
// so teardown can drop the schema and close the pool.
const bundles = new Map<AgentStorage, PostgresStorage>()

runAgentStorageContractSuite("PgAgentStorage", {
  createStorage: async () => {
    const { storage } = await createTestStorage()
    bundles.set(storage.agents, storage)
    return storage.agents
  },
  teardown: async (agents) => {
    const storage = bundles.get(agents)
    if (storage) {
      bundles.delete(agents)
      await storage.dropSchema()
      await storage.close()
    }
  },
})

describe("PostgresStorage agents", () => {
  test("is bundled and rolls back agent writes when a transaction throws", async () => {
    const { storage } = await createTestStorage()

    try {
      expect(storage.agents).toBeInstanceOf(PgAgentStorage)

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

      expect(await storage.agents.runs.getById({ projectId: "p", id: "run_1" })).toBeNull()
      expect(await storage.agents.messages.getById({ projectId: "p", id: "msg_asst_1" })).toBeNull()
      await expect(
        storage.agents.threads.getById({ projectId: "p", id: "thr_1" })
      ).resolves.toMatchObject({ activeRunId: null, messageCount: 0 })
    } finally {
      await storage.dropSchema()
      await storage.close()
    }
  })
})
