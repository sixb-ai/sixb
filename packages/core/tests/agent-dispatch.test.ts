import { describe, expect, test } from "bun:test"
import { InMemoryQueues, InMemoryStorage } from "../src"
import { agentRunQueueJobId, dispatchQueuedAgentRuns } from "../src/agents"

const PROJECT_ID = "agent-dispatch-tests"

async function createQueuedRun(storage: InMemoryStorage, id = "run-1") {
  await storage.agents.threads.create({
    id: `thread-${id}`,
    projectId: PROJECT_ID,
    agentId: "assistant",
    ownerPrincipal: { type: "system", id: "system" },
  })
  return storage.agents.runs.create({
    id,
    projectId: PROJECT_ID,
    threadId: `thread-${id}`,
    agentId: "assistant",
    triggerMessageId: `message-${id}`,
    requestedByPrincipal: { type: "system", id: "system" },
  })
}

describe("dispatchQueuedAgentRuns", () => {
  test("publishes queued runs with a deterministic, idempotent queue id", async () => {
    const storage = new InMemoryStorage()
    const queues = new InMemoryQueues()
    const run = await createQueuedRun(storage)

    const first = await dispatchQueuedAgentRuns({
      projectId: PROJECT_ID,
      storage: storage.agents,
      queue: queues.agents,
    })
    const second = await dispatchQueuedAgentRuns({
      projectId: PROJECT_ID,
      storage: storage.agents,
      queue: queues.agents,
    })

    expect(first.dispatched).toEqual([{ runId: run.id, jobId: agentRunQueueJobId(run.id) }])
    expect(second.dispatched).toEqual(first.dispatched)
    const claimed = await queues.agents.claim({
      projectId: PROJECT_ID,
      workerId: "worker",
      limit: 2,
    })
    expect(claimed).toHaveLength(1)
    expect(claimed[0]?.job.payload).toEqual({
      agentId: run.agentId,
      threadId: run.threadId,
      runId: run.id,
      triggerMessageId: run.triggerMessageId,
    })
  })

  test("skips runs that are no longer queued", async () => {
    const storage = new InMemoryStorage()
    const queues = new InMemoryQueues()
    const run = await createQueuedRun(storage)
    await storage.agents.runs.finishQueued({
      projectId: PROJECT_ID,
      id: run.id,
      status: "cancelled",
    })

    const result = await dispatchQueuedAgentRuns({
      projectId: PROJECT_ID,
      storage: storage.agents,
      queue: queues.agents,
      runIds: [run.id],
    })

    expect(result).toEqual({ scanned: 0, dispatched: [], failures: [] })
  })

  test("reports publication failures without changing the durable queued run", async () => {
    const storage = new InMemoryStorage()
    const queues = new InMemoryQueues()
    const run = await createQueuedRun(storage)
    queues.agents.enqueue = () => Promise.reject(new Error("queue unavailable"))

    const result = await dispatchQueuedAgentRuns({
      projectId: PROJECT_ID,
      storage: storage.agents,
      queue: queues.agents,
    })

    expect(result.dispatched).toEqual([])
    expect(result.failures).toHaveLength(1)
    expect(await storage.agents.runs.getById({ projectId: PROJECT_ID, id: run.id })).toMatchObject({
      status: "queued",
      attempt: 0,
    })
  })
})
