import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { migrateStorage } from "@sixb/core"
import { createTestAgentExecution, runAgentStorageContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"
import { SqliteAgentStorage } from "../src/agents"

runAgentStorageContractSuite("SqliteAgentStorage", {
  createStorage: () => new SqliteStorage(),
  teardown: (storage) => {
    storage.close()
  },
})

describe("SqliteStorage agents", () => {
  test("admits a conversation run after file-backed migrations", async () => {
    // Bun 1.3.14 enables legacy_alter_table by default. With foreign_keys OFF during migrations,
    // SQLite does not rewrite a temporary self-reference on rename. Reintroducing
    // REFERENCES agent_runs_v4 in migration 030 makes this insert fail (memory-only stores pass).
    const path = await mkdtemp(join(tmpdir(), "sixb-agent-migration-"))
    const storage = new SqliteStorage({ path })
    try {
      await migrateStorage(storage)
      await storage.agents.threads.create({
        id: "thread",
        projectId: "project",
        ownerPrincipal: { type: "user", id: "user" },
      })
      const executionId = await createTestAgentExecution(storage, {
        projectId: "project",
        runId: "run",
        authority: "inherited",
      })
      await expect(
        storage.agents.runs.create({
          id: "run",
          projectId: "project",
          executionId,
          threadId: "thread",
          triggerMessageId: "message",
          spec: { model: { provider: "test", modelId: "test-model" } },
          requesterGroupIds: [],
        })
      ).resolves.toMatchObject({ id: "run", status: "queued" })
    } finally {
      storage.close()
      await rm(path, { recursive: true, force: true })
    }
  })

  test("is bundled into the composite storage", async () => {
    const storage = new SqliteStorage()

    try {
      expect(storage.agents).toBeInstanceOf(SqliteAgentStorage)

      await storage.agents.threads.create({
        id: "thr_1",
        projectId: "p",
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
            requesterGroupIds: ["engineering"],
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
