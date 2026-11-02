import { describe, expect, test } from "bun:test"
import { InMemoryStorage } from "../src"
import { movesComputerPlace } from "../src/storage/agents/provider"
import { createTestAgentExecution, runAgentStorageContractSuite } from "../src/testing"

runAgentStorageContractSuite("InMemoryAgentStorage", {
  createStorage: () => new InMemoryStorage(),
})

describe("InMemoryStorage agents", () => {
  test("rolls back agent writes when a transaction throws", async () => {
    const storage = new InMemoryStorage()
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
    const thread = await storage.agents.threads.getById({ projectId: "p", id: "thr_1" })
    expect(thread).toMatchObject({ activeRunId: null, messageCount: 0 })
  })
})

// Guard proof: require a previous computer in movesComputerPlace; the first folder of a conversation
// from before folders were kept skips the running-turn refusal and the note about earlier files.
test("a first folder counts as a move for a thread from before folders were kept", () => {
  const computer = { id: "laptop", name: "Laptop", folder: "/work" }
  const thread = (place?: typeof computer) =>
    ({ ...(place ? { computer: place } : {}) }) as Parameters<typeof movesComputerPlace>[0]

  expect(movesComputerPlace(thread(), computer)).toBe(true)
  expect(movesComputerPlace(thread(computer), { ...computer, name: "Renamed" })).toBe(false)
  expect(movesComputerPlace(thread(computer), { ...computer, folder: "/other" })).toBe(true)
})
