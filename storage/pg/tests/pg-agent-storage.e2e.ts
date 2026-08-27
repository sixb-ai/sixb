import { describe, expect, test } from "bun:test"
import { AgentStorageError } from "@sixb/core/storage"
import { createTestAgentExecution, runAgentStorageContractSuite } from "@sixb/core/testing"
import { PgAgentStorage } from "../src/agents"
import { createTestStorage } from "./helpers"

type TestStorage = Awaited<ReturnType<typeof createTestStorage>>["storage"]

async function prepareCheckpointCandidate(storage: TestStorage): Promise<void> {
  const agents = storage.agents
  await agents.threads.create({
    id: "thr_lock_order",
    projectId: "p",
    agentId: "sales",
    ownerPrincipal: { type: "user", id: "usr_1" },
  })
  await agents.messages.append({
    id: "msg_1",
    projectId: "p",
    threadId: "thr_lock_order",
    runId: null,
    role: "user",
    parts: [{ type: "text", text: "one" }],
  })

  const firstExecutionId = await createTestAgentExecution(storage, {
    projectId: "p",
    agentId: "sales",
    runId: "run_1",
  })
  await agents.runs.create({
    id: "run_1",
    projectId: "p",
    executionId: firstExecutionId,
    threadId: "thr_lock_order",
    agentId: "sales",
    triggerMessageId: "msg_1",
    requesterGroupIds: [],
  })
  await agents.runs.start({
    id: "run_1",
    projectId: "p",
    execution: {
      token: "execution_1",
      queueLeaseExpiresAt: new Date("2026-08-27T12:05:00.000Z"),
    },
  })
  await agents.messages.append({
    id: "msg_2",
    projectId: "p",
    threadId: "thr_lock_order",
    runId: "run_1",
    role: "assistant",
    parts: [{ type: "text", text: "two" }],
  })
  await agents.runs.finish({
    id: "run_1",
    projectId: "p",
    executionToken: "execution_1",
    status: "succeeded",
  })

  await agents.messages.append({
    id: "msg_3",
    projectId: "p",
    threadId: "thr_lock_order",
    runId: null,
    role: "user",
    parts: [{ type: "text", text: "three" }],
  })
  const secondExecutionId = await createTestAgentExecution(storage, {
    projectId: "p",
    agentId: "sales",
    runId: "run_2",
  })
  await agents.runs.create({
    id: "run_2",
    projectId: "p",
    executionId: secondExecutionId,
    threadId: "thr_lock_order",
    agentId: "sales",
    triggerMessageId: "msg_3",
    requesterGroupIds: [],
  })
  await agents.runs.start({
    id: "run_2",
    projectId: "p",
    execution: {
      token: "execution_2",
      queueLeaseExpiresAt: new Date("2026-08-27T12:10:00.000Z"),
    },
  })
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms.`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

runAgentStorageContractSuite("PgAgentStorage", {
  createStorage: async () => {
    const { storage } = await createTestStorage()
    return storage
  },
  teardown: async (storage) => {
    await storage.dropSchema()
    await storage.close()
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
          if (!tx.auth) throw new Error("expected auth storage")
          const executionId = await createTestAgentExecution(
            { auth: tx.auth, executions: tx.executions },
            { projectId: "p", agentId: "sales", runId: "run_1" }
          )
          await tx.agents?.runs.create({
            id: "run_1",
            projectId: "p",
            executionId,
            threadId: "thr_1",
            agentId: "sales",
            triggerMessageId: "msg_1",
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

      expect(
        await storage.executions.getById({ projectId: "p", id: "test_agent_execution:run_1" })
      ).toBeNull()
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

  test("uses one run-then-thread lock order for finalization and checkpoint creation", async () => {
    const { storage } = await createTestStorage()

    try {
      await prepareCheckpointCandidate(storage)
      let resolveAppended: () => void = () => {}
      let rejectAppended: (error: unknown) => void = () => {}
      const appended = new Promise<void>((resolve, reject) => {
        resolveAppended = resolve
        rejectAppended = reject
      })
      let allowFinish: () => void = () => {}
      const finishAllowed = new Promise<void>((resolve) => {
        allowFinish = resolve
      })

      const finalization = storage
        .transaction(async (tx) => {
          const agents = tx.agents
          if (!agents) throw new Error("Expected agent storage in transaction.")
          await agents.messages.append({
            id: "msg_4",
            projectId: "p",
            threadId: "thr_lock_order",
            runId: "run_2",
            role: "assistant",
            parts: [{ type: "text", text: "four" }],
          })
          resolveAppended()
          await finishAllowed
          return agents.runs.finish({
            id: "run_2",
            projectId: "p",
            executionToken: "execution_2",
            status: "succeeded",
          })
        })
        .then(
          (value) => ({ status: "fulfilled", value }) as const,
          (reason: unknown) => {
            rejectAppended(reason)
            return { status: "rejected", reason } as const
          }
        )

      await settleWithin(appended, 2_000)
      const checkpoint = storage.agents.checkpoints
        .create({
          id: "checkpoint_lock_order",
          projectId: "p",
          threadId: "thr_lock_order",
          createdByRunId: "run_2",
          expectedPreviousCheckpointId: null,
          expectedHeadSeq: 4,
          executionToken: "execution_2",
          reason: "threshold",
          summary: "The first turn was completed.",
          summaryFormatVersion: 1,
          summarizedThroughSeq: 2,
          observedHeadSeq: 4,
          estimatedInputTokensBefore: 1_000,
          estimatedInputTokensAfter: 300,
          summaryModelId: "test-model",
        })
        .then(
          (value) => ({ status: "fulfilled", value }) as const,
          (reason: unknown) => ({ status: "rejected", reason }) as const
        )

      // Let the competing checkpoint reach its first row lock. With the old thread-then-run
      // append order, finalization and checkpoint creation now formed a deterministic deadlock.
      await Bun.sleep(100)
      allowFinish()

      const [finalizationResult, checkpointResult] = await settleWithin(
        Promise.all([finalization, checkpoint]),
        5_000
      )
      if (finalizationResult.status === "rejected") throw finalizationResult.reason
      expect(finalizationResult.value.status).toBe("succeeded")
      expect(checkpointResult.status).toBe("rejected")
      if (checkpointResult.status === "fulfilled") {
        throw new Error("Checkpoint unexpectedly won the finalization race.")
      }
      expect(checkpointResult.reason).toBeInstanceOf(AgentStorageError)
      expect(checkpointResult.reason).toMatchObject({ code: "invalid_state" })
    } finally {
      await storage.dropSchema()
      await storage.close()
    }
  }, 10_000)
})
