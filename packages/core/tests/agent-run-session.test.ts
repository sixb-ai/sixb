import { afterEach, describe, expect, jest, test } from "bun:test"
import { InMemoryBroker, InMemoryStorage } from "../src"
import {
  AgentExecutionLostError,
  AgentFinalizationError,
  claimAgentRun,
  NOOP_STREAM_SINK,
  publishAgentRunCancel,
} from "../src/agents"
import { AgentStorageError } from "../src/storage/agents"
import { createTestAgentExecution } from "../src/testing"

const PROJECT_ID = "agent-run-session-tests"
const LEASE = "2099-01-01T00:00:00.000Z"

afterEach(() => {
  jest.useRealTimers()
})

async function setup(id = "run-1") {
  const storage = new InMemoryStorage()
  const broker = new InMemoryBroker()
  await storage.agents.threads.create({
    id: `thread-${id}`,
    projectId: PROJECT_ID,
    ownerPrincipal: { type: "system", id: "system" },
  })
  const executionId = await createTestAgentExecution(storage, { projectId: PROJECT_ID, runId: id })
  const run = await storage.agents.runs.create({
    id,
    projectId: PROJECT_ID,
    executionId,
    threadId: `thread-${id}`,
    triggerMessageId: `message-${id}`,
    spec: { model: { provider: "test", modelId: "test-model" } },
  })
  const host = {
    projectId: PROJECT_ID,
    storage,
    broker,
    recoverAiModelCall: async () => {},
    events: NOOP_STREAM_SINK,
  }
  return { storage, broker, run, host }
}

describe("claimAgentRun", () => {
  test("starts a queued run with a fresh execution token", async () => {
    const { host, run } = await setup()

    const session = await claimAgentRun(host, { run, leaseExpiresAt: LEASE })

    expect(session?.run.status).toBe("running")
    expect(session?.executionToken).toBe(session?.run.execution?.token)
    session?.close()
  })

  test("returns nothing for a run that already ended", async () => {
    const { host, storage, run } = await setup()
    const ended = await storage.agents.runs.finishQueued({
      projectId: PROJECT_ID,
      id: run.id,
      status: "cancelled",
    })

    expect(await claimAgentRun(host, { run: ended, leaseExpiresAt: LEASE })).toBeNull()
  })

  // Guard proof: let `runs.start`'s invalid_state through in startOrReclaim; the claim throws.
  test("returns nothing for a queued run that ended since it was read", async () => {
    const { host, storage, run } = await setup()
    await storage.agents.runs.finishQueued({
      projectId: PROJECT_ID,
      id: run.id,
      status: "cancelled",
    })

    expect(await claimAgentRun(host, { run, leaseExpiresAt: LEASE })).toBeNull()
  })

  // The fence the whole session rests on. Return the running run unchanged in startOrReclaim, in
  // place of `runs.reclaim`; the token never rotates and the earlier session keeps writing.
  test("a reclaim fences the earlier session out of every write", async () => {
    const { host, run } = await setup()
    const first = await claimAgentRun(host, { run, leaseExpiresAt: LEASE })
    if (!first) throw new Error("Expected the run to be claimed.")
    const second = await claimAgentRun(host, { run: first.run, leaseExpiresAt: LEASE })
    if (!second) throw new Error("Expected the run to be reclaimed.")

    expect(second.executionToken).not.toBe(first.executionToken)
    expect(await first.finish({ status: "succeeded" }).catch((error) => error)).toBeInstanceOf(
      AgentExecutionLostError
    )
    expect(await first.renewLease(LEASE).catch((error) => error)).toBeDefined()
    expect((await second.finish({ status: "succeeded" })).status).toBe("succeeded")
    first.close()
    second.close()
  })
})

describe("an agent run session", () => {
  test("finishes with what the run did, in one transaction", async () => {
    const { host, storage, run } = await setup()
    const session = await claimAgentRun(host, { run, leaseExpiresAt: LEASE })
    if (!session) throw new Error("Expected the run to be claimed.")

    const finished = await session.finish({ status: "succeeded", finishReason: "stop" }, [
      {
        id: "message-answer",
        projectId: PROJECT_ID,
        threadId: run.threadId,
        runId: run.id,
        role: "assistant",
        parts: [{ type: "text", text: "Done." }],
      },
    ])

    expect(finished).toMatchObject({ status: "succeeded", finishReason: "stop" })
    const messages = await storage.agents.messages.list({
      projectId: PROJECT_ID,
      threadId: run.threadId,
    })
    expect(messages.messages.map((message) => message.id)).toContain("message-answer")
    session.close()
  })

  test("retries a transient storage failure, and gives up after 850ms", async () => {
    const { host, storage, run } = await setup()
    const session = await claimAgentRun(host, { run, leaseExpiresAt: LEASE })
    if (!session) throw new Error("Expected the run to be claimed.")
    const finish = storage.agents.runs.finish.bind(storage.agents.runs)
    let failures = 1
    storage.agents.runs.finish = async (input) => {
      if (failures-- > 0) throw new Error("storage blip")
      return finish(input)
    }

    // One blip, absorbed.
    expect((await session.finish({ status: "succeeded" })).status).toBe("succeeded")

    const { host: downHost, storage: down, run: other } = await setup("run-2")
    const stuck = await claimAgentRun(downHost, { run: other, leaseExpiresAt: LEASE })
    if (!stuck) throw new Error("Expected the run to be claimed.")
    let attempts = 0
    down.agents.runs.finish = async () => {
      attempts += 1
      throw new Error("storage down")
    }
    jest.useFakeTimers()
    const start = Date.now()
    let outcome: unknown
    void stuck.finish({ status: "succeeded" }).catch((error: unknown) => {
      outcome = error
    })
    // Each step takes one real event-loop turn, then moves fake time on.
    for (let step = 0; step < 100 && outcome === undefined; step += 1) {
      await new Promise<void>((resolve) => {
        const { port1, port2 } = new MessageChannel()
        port1.onmessage = () => {
          port1.close()
          port2.close()
          resolve()
        }
        port2.postMessage(null)
      })
      if (outcome === undefined) jest.advanceTimersByTime(50)
    }
    expect(outcome).toBeInstanceOf(AgentFinalizationError)
    expect(attempts).toBe(4)
    // The backoff is 50 + 200 + 600ms: shortened or stretched, this fails.
    expect(Date.now() - start).toBeGreaterThanOrEqual(850)
    expect(Date.now() - start).toBeLessThan(1_000)
    session.close()
    stuck.close()
  })

  // The worker loads the recorder inside its preparation, which retries a blip in place. Cache the
  // rejected read in AgentRunSession.modelCalls; the second call fails too.
  test("reads the run's model-call accounting on first use, again after a failed read", async () => {
    const { host, storage, run } = await setup()
    const session = await claimAgentRun(host, { run, leaseExpiresAt: LEASE })
    if (!session) throw new Error("Expected the run to be claimed.")
    const getById = storage.executions.getById.bind(storage.executions)
    let failures = 1
    storage.executions.getById = async (input) => {
      if (failures-- > 0) throw new Error("storage blip")
      return getById(input)
    }

    expect(await session.modelCalls().catch((error: unknown) => error)).toBeInstanceOf(Error)
    const modelCalls = await session.modelCalls()
    expect(modelCalls.executionId).toBe(run.executionId)
    expect(await session.modelCalls()).toBe(modelCalls)
    session.close()
  })

  test("is cancelled with its own run, and with a run named in cancelWith", async () => {
    const { host, broker, run } = await setup()
    const session = await claimAgentRun(host, {
      run,
      leaseExpiresAt: LEASE,
      cancelWith: ["parent-run"],
    })
    if (!session) throw new Error("Expected the run to be claimed.")
    const cancelled = new Promise<void>((resolve) =>
      session.cancelled.addEventListener("abort", () => resolve(), { once: true })
    )

    await publishAgentRunCancel(broker, { projectId: PROJECT_ID, runId: "parent-run" })

    await cancelled
    expect(session.cancelled.aborted).toBe(true)
    session.close()
  })
})

describe("an agent run session's children and mail", () => {
  // Clearing a dead attempt deletes messages from a child's thread: a turn reclaimed by another
  // delivery must not. Drop assertOwned from clearAttempt in run-session-children.ts; it deletes.
  test("clears a child's dead attempt only while the turn owns its run", async () => {
    const { host, storage, run } = await setup()
    const first = await claimAgentRun(host, { run, leaseExpiresAt: LEASE })
    if (!first) throw new Error("Expected the run to be claimed.")
    await storage.agents.messages.append({
      id: "message-dead",
      projectId: PROJECT_ID,
      threadId: run.threadId,
      runId: run.id,
      role: "assistant",
      parts: [{ type: "text", text: "From a failed attempt." }],
    })
    const second = await claimAgentRun(host, { run: first.run, leaseExpiresAt: LEASE })
    if (!second) throw new Error("Expected the run to be reclaimed.")

    const refused = await first.children
      .clearAttempt({ threadId: run.threadId, runId: run.id })
      .catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(AgentStorageError)
    expect(
      await storage.agents.messages.getById({ projectId: PROJECT_ID, id: "message-dead" })
    ).toBeDefined()

    await second.children.clearAttempt({ threadId: run.threadId, runId: run.id })
    expect(
      await storage.agents.messages.getById({ projectId: PROJECT_ID, id: "message-dead" })
    ).toBeNull()
    first.close()
    second.close()
  })

  // Compaction's checkpoint is the one write a run makes to its conversation besides finishing.
  // Write it with the token storage holds now in place of the session's; the stale write lands.
  test("writes a context checkpoint only while the turn owns its run", async () => {
    const { host, run } = await setup()
    const first = await claimAgentRun(host, { run, leaseExpiresAt: LEASE })
    if (!first) throw new Error("Expected the run to be claimed.")
    const checkpoint = (id: string) => ({
      id,
      threadId: run.threadId,
      expectedPreviousCheckpointId: null,
      expectedHeadSeq: 2,
      reason: "threshold" as const,
      summary: "Earlier turns.",
      summaryFormatVersion: 1 as const,
      summarizedThroughSeq: 1,
      observedHeadSeq: 2,
      estimatedInputTokensBefore: 10,
      estimatedInputTokensAfter: 5,
      summaryModelId: "test-model",
    })
    await host.storage.agents.messages.append({
      id: "message-earlier",
      projectId: PROJECT_ID,
      threadId: run.threadId,
      runId: run.id,
      role: "assistant",
      parts: [{ type: "text", text: "An earlier answer." }],
    })
    await host.storage.agents.messages.append({
      id: "message-head",
      projectId: PROJECT_ID,
      threadId: run.threadId,
      runId: run.id,
      role: "user",
      parts: [{ type: "text", text: "The latest question." }],
    })
    const second = await claimAgentRun(host, { run: first.run, leaseExpiresAt: LEASE })
    if (!second) throw new Error("Expected the run to be reclaimed.")

    expect(
      await first.conversation.createCheckpoint(checkpoint("ckpt-stale")).catch((error) => error)
    ).toBeInstanceOf(AgentStorageError)
    expect((await second.conversation.createCheckpoint(checkpoint("ckpt-1"))).id).toBe("ckpt-1")
    first.close()
    second.close()
  })

  test("sends mail to a child's thread inbox and reads it back from a cursor", async () => {
    const { host, run } = await setup()
    const session = await claimAgentRun(host, { run, leaseExpiresAt: LEASE })
    if (!session) throw new Error("Expected the run to be claimed.")
    const mail = (id: string) =>
      ({
        id,
        fromRunId: run.id,
        toThreadId: "thread-child",
        kind: "message",
        text: id,
        sentAt: "2026-10-29T12:00:00.000Z",
      }) as const

    await session.mail.send(mail("first"))
    const page = await session.mail.read({ threadId: "thread-child" })
    await session.mail.send(mail("second"))
    const next = await session.mail.read({ threadId: "thread-child" }, page.cursor)

    expect(page.mail.map((item) => item.id)).toEqual(["first"])
    expect(next.mail.map((item) => item.id)).toEqual(["second"])
    session.close()
  })
})
