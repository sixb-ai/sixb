import { describe, expect, test } from "bun:test"
import { AgentStorageError } from "@sixb/core/storage"
import { createTestAgentExecution, runAgentStorageContractSuite } from "@sixb/core/testing"
import { PgAgentStorage } from "../src/agents"
import { createTestStorage, disposeTestStorage, waitForLockWait } from "./helpers"

type TestStorage = Awaited<ReturnType<typeof createTestStorage>>["storage"]

async function prepareCheckpointCandidate(storage: TestStorage): Promise<void> {
  const agents = storage.agents
  await agents.threads.create({
    id: "thr_lock_order",
    projectId: "p",
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
    runId: "run_1",
  })
  await agents.runs.create({
    id: "run_1",
    projectId: "p",
    executionId: firstExecutionId,
    threadId: "thr_lock_order",
    triggerMessageId: "msg_1",
    spec: { model: { provider: "test", modelId: "test-model" } },
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
    runId: "run_2",
  })
  await agents.runs.create({
    id: "run_2",
    projectId: "p",
    executionId: secondExecutionId,
    threadId: "thr_lock_order",
    triggerMessageId: "msg_3",
    spec: { model: { provider: "test", modelId: "test-model" } },
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
  teardown: disposeTestStorage,
})

describe("PostgresStorage agents", () => {
  test("is bundled and rolls back agent writes when a transaction throws", async () => {
    const { storage } = await createTestStorage()

    try {
      expect(storage.agents).toBeInstanceOf(PgAgentStorage)

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

      expect(
        await storage.executions.getById({ projectId: "p", id: "test_agent_execution:run_1" })
      ).toBeNull()
      expect(await storage.agents.runs.getById({ projectId: "p", id: "run_1" })).toBeNull()
      expect(await storage.agents.messages.getById({ projectId: "p", id: "msg_asst_1" })).toBeNull()
      await expect(
        storage.agents.threads.getById({ projectId: "p", id: "thr_1" })
      ).resolves.toMatchObject({ activeRunId: null, messageCount: 0 })
    } finally {
      await disposeTestStorage(storage)
    }
  })

  // Guard proof: drop FOR UPDATE from PgAgentThreadStore.addParticipants; the second add then
  // reads the committed participants only, both commit, and the thread holds three.
  test("an add waits for one still adding to the same thread, so the limit holds", async () => {
    const { storage } = await createTestStorage()
    const alice = { type: "user", id: "usr_alice" } as const
    const input = (id: string) => ({
      projectId: "p",
      threadId: "thr_shared",
      principals: [{ type: "user", id } as const],
      addedBy: alice,
      maxParticipants: 2,
    })

    try {
      await storage.agents.threads.create({
        projectId: "p",
        id: "thr_shared",
        ownerPrincipal: alice,
      })
      await storage.agents.threads.addParticipants(input("usr_bob"))

      let added: () => void = () => {}
      const addedInTransaction = new Promise<void>((resolve) => {
        added = resolve
      })
      let commit: () => void = () => {}
      const committing = new Promise<void>((resolve) => {
        commit = resolve
      })
      const first = storage.transaction(async (tx) => {
        await tx.agents?.threads.addParticipants(input("usr_cleo"))
        added()
        await committing
      })

      await settleWithin(addedInTransaction, 2_000)
      const second = storage.agents.threads.addParticipants(input("usr_dan")).then(
        () => "added",
        (error: unknown) => error
      )
      await Bun.sleep(100)
      commit()
      await first

      expect(await settleWithin(second, 2_000)).toMatchObject({ code: "participant_limit" })
      expect(
        (
          await storage.agents.threads.listParticipants({
            projectId: "p",
            threadIds: ["thr_shared"],
          })
        ).map((participant) => participant.principal.id)
      ).toEqual(["usr_bob", "usr_cleo"])
    } finally {
      await storage.dropSchema()
      await storage.close()
    }
  })

  test("uses one run-then-thread lock order for finalization and checkpoint creation", async () => {
    const { storage, connectionString } = await createTestStorage()

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
      await waitForLockWait(connectionString, checkpoint)
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
      // The run ended first: the checkpoint finds it no longer held, as a reclaimed run is not.
      expect(checkpointResult.reason).toBeInstanceOf(AgentStorageError)
      expect(checkpointResult.reason).toMatchObject({ code: "execution_lost" })
    } finally {
      await disposeTestStorage(storage)
    }
  }, 10_000)

  test("forks after an answer being finalized, never in the middle of it", async () => {
    // Removal proof: drop `FOR SHARE` from the fork's source read; the fork no longer waits, and
    // leaves behind a turn whose answer commits right after.
    const { storage } = await createTestStorage()
    const finishAllowed = Promise.withResolvers<void>()

    try {
      await prepareCheckpointCandidate(storage)
      const appended = Promise.withResolvers<void>()

      const finalization = storage.transaction(async (tx) => {
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
        appended.resolve()
        await finishAllowed.promise

        return agents.runs.finish({
          id: "run_2",
          projectId: "p",
          executionToken: "execution_2",
          status: "succeeded",
        })
      })

      await settleWithin(appended.promise, 2_000)
      let forked = false
      const fork = storage.agents.threads
        .fork({
          projectId: "p",
          sourceThreadId: "thr_lock_order",
          id: "thr_fork",
          ownerPrincipal: { type: "user", id: "usr_2" },
        })
        .finally(() => {
          forked = true
        })

      await Bun.sleep(100)
      expect(forked).toBe(false)

      finishAllowed.resolve()
      await settleWithin(finalization, 5_000)
      expect(await settleWithin(fork, 5_000)).toMatchObject({ messageCount: 4 })
    } finally {
      // A failed expectation must not leave the held transaction blocking the cleanup.
      finishAllowed.resolve()
      await storage.dropSchema()
      await storage.close()
    }
  }, 10_000)

  test("finalizes an answer after a fork in progress, which leaves the turn behind", async () => {
    const { storage } = await createTestStorage()
    const commitAllowed = Promise.withResolvers<void>()

    try {
      await prepareCheckpointCandidate(storage)
      const forked = Promise.withResolvers<void>()

      const fork = storage.transaction(async (tx) => {
        const agents = tx.agents
        if (!agents) throw new Error("Expected agent storage in transaction.")

        const thread = await agents.threads.fork({
          projectId: "p",
          sourceThreadId: "thr_lock_order",
          id: "thr_fork",
          ownerPrincipal: { type: "user", id: "usr_2" },
        })
        forked.resolve()
        await commitAllowed.promise

        return thread
      })

      await settleWithin(forked.promise, 2_000)
      let finalized = false
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
          return agents.runs.finish({
            id: "run_2",
            projectId: "p",
            executionToken: "execution_2",
            status: "succeeded",
          })
        })
        .finally(() => {
          finalized = true
        })

      await Bun.sleep(100)
      expect(finalized).toBe(false)

      commitAllowed.resolve()
      expect(await settleWithin(fork, 5_000)).toMatchObject({ messageCount: 2 })
      await settleWithin(finalization, 5_000)

      const copied = await storage.agents.messages.list({ projectId: "p", threadId: "thr_fork" })
      expect(copied.total).toBe(2)
      expect(
        await storage.agents.threads.getById({ projectId: "p", id: "thr_lock_order" })
      ).toMatchObject({ activeRunId: null, messageCount: 4 })
    } finally {
      commitAllowed.resolve()
      await storage.dropSchema()
      await storage.close()
    }
  }, 10_000)
})
