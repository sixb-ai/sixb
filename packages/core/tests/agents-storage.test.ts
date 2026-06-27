import { describe, expect, test } from "bun:test"
import { AgentStorageError, InMemoryAgentStorage, InMemoryStorage } from "../src"
import { runAgentStorageContractSuite } from "../src/testing"

runAgentStorageContractSuite("InMemoryAgentStorage", {
  createStorage: () => new InMemoryAgentStorage(),
})

describe("InMemoryStorage agents", () => {
  test("is wired into the composite storage", () => {
    const storage = new InMemoryStorage()
    expect(storage.agents).toBeInstanceOf(InMemoryAgentStorage)
  })

  test("rolls back agent writes when a transaction throws", async () => {
    const storage = new InMemoryStorage()
    await storage.agents.threads.create({
      id: "thr_1",
      projectId: "p",
      agentId: "sales",
      ownerPrincipal: { type: "user", id: "usr_1" },
      createdAt: new Date("2026-06-23T10:00:00.000Z"),
    })

    await expect(
      storage.transaction(async (tx) => {
        await tx.agents?.runs.reserve({
          id: "run_1",
          projectId: "p",
          threadId: "thr_1",
          agentId: "sales",
          triggerMessageId: "msg_1",
          requestedByPrincipal: { type: "user", id: "usr_1" },
          lease: { id: "lease_1", expiresAt: new Date("2026-06-23T10:05:00.000Z") },
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

    // Nothing partial survived: no run, no message, thread untouched.
    expect(await storage.agents.runs.getById({ projectId: "p", id: "run_1" })).toBeNull()
    expect(await storage.agents.messages.getById({ projectId: "p", id: "msg_asst_1" })).toBeNull()
    const thread = await storage.agents.threads.getById({ projectId: "p", id: "thr_1" })
    expect(thread).toMatchObject({ activeRunId: null, messageCount: 0 })
  })

  test("commits append + finish atomically", async () => {
    const storage = new InMemoryStorage()
    await storage.agents.threads.create({
      id: "thr_1",
      projectId: "p",
      agentId: "sales",
      ownerPrincipal: { type: "user", id: "usr_1" },
      createdAt: new Date("2026-06-23T10:00:00.000Z"),
    })
    await storage.agents.runs.reserve({
      id: "run_1",
      projectId: "p",
      threadId: "thr_1",
      agentId: "sales",
      triggerMessageId: "msg_1",
      requestedByPrincipal: { type: "user", id: "usr_1" },
      lease: { id: "lease_1", expiresAt: new Date("2026-06-23T10:05:00.000Z") },
      createdAt: new Date("2026-06-23T10:00:10.000Z"),
    })

    await storage.transaction(async (tx) => {
      await tx.agents?.messages.append({
        id: "msg_asst_1",
        projectId: "p",
        threadId: "thr_1",
        runId: "run_1",
        role: "assistant",
        parts: [{ type: "text", text: "done" }],
        createdAt: new Date("2026-06-23T10:01:00.000Z"),
      })
      await tx.agents?.runs.finish({
        projectId: "p",
        id: "run_1",
        leaseId: "lease_1",
        status: "succeeded",
        completedAt: new Date("2026-06-23T10:01:01.000Z"),
      })
    })

    expect(
      await storage.agents.messages.getById({ projectId: "p", id: "msg_asst_1" })
    ).toMatchObject({
      seq: 1,
    })
    expect(await storage.agents.runs.getById({ projectId: "p", id: "run_1" })).toMatchObject({
      status: "succeeded",
    })
    expect(await storage.agents.threads.getById({ projectId: "p", id: "thr_1" })).toMatchObject({
      activeRunId: null,
      messageCount: 1,
    })
  })

  test("snapshot/restore round-trips the agent store", () => {
    const store = new InMemoryAgentStorage()
    return (async () => {
      await store.threads.create({
        id: "thr_1",
        projectId: "p",
        agentId: "sales",
        ownerPrincipal: { type: "user", id: "usr_1" },
        createdAt: new Date("2026-06-23T10:00:00.000Z"),
      })
      const snapshot = store.snapshot()
      await store.threads.create({
        id: "thr_2",
        projectId: "p",
        agentId: "sales",
        ownerPrincipal: { type: "user", id: "usr_1" },
        createdAt: new Date("2026-06-23T10:01:00.000Z"),
      })
      expect((await store.threads.list({ projectId: "p" })).total).toBe(2)

      store.restore(snapshot)
      const after = await store.threads.list({ projectId: "p" })
      expect(after.total).toBe(1)
      expect(after.threads[0]?.id).toBe("thr_1")
    })()
  })

  test("exposes the AgentStorageError code surface", () => {
    const error = new AgentStorageError("lease_lost", "[Sixb] gone")
    expect(error.code).toBe("lease_lost")
    expect(error.name).toBe("AgentStorageError")
  })
})
