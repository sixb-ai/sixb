import { describe, expect, test } from "bun:test"
import { InMemoryQueues, InMemoryStorage } from "../src"
import { agentRunQueueJobId, dispatchQueuedAgentRuns } from "../src/agents"
import { createTestAgentExecution } from "../src/testing"

const PROJECT_ID = "agent-dispatch-tests"

async function createQueuedRun(storage: InMemoryStorage, id = "run-1") {
  await storage.agents.threads.create({
    id: `thread-${id}`,
    projectId: PROJECT_ID,
    ownerPrincipal: { type: "system", id: "system" },
  })
  const executionId = await createTestAgentExecution(storage, {
    projectId: PROJECT_ID,
    runId: id,
  })
  return storage.agents.runs.create({
    id,
    projectId: PROJECT_ID,
    executionId,
    threadId: `thread-${id}`,
    triggerMessageId: `message-${id}`,
    spec: { model: { provider: "test", modelId: "test-model" } },
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
    expect(claimed[0]?.job.payload).toEqual({ runId: run.id })
  })

  // Guard proof: drop excludeComputerTurns from dispatchQueuedAgentRuns; the older turn waiting for
  // a computer fills the scan, and the cloud run it hides stays queued.
  test("finds cloud runs however many older turns wait for a computer", async () => {
    const storage = new InMemoryStorage()
    const queues = new InMemoryQueues()
    await storage.agents.threads.create({
      id: "thread-computer",
      projectId: PROJECT_ID,
      ownerPrincipal: { type: "system", id: "system" },
      runsOn: "computer",
      computer: { id: "laptop", name: "Laptop", folder: "/work" },
    })
    await storage.agents.runs.create({
      id: "run-0-computer",
      projectId: PROJECT_ID,
      executionId: await createTestAgentExecution(storage, {
        projectId: PROJECT_ID,
        runId: "run-0-computer",
      }),
      threadId: "thread-computer",
      triggerMessageId: "message-computer",
      spec: { model: { provider: "test", modelId: "test-model" }, runsOn: "computer" },
    })
    const cloud = await createQueuedRun(storage)

    const dispatch = await dispatchQueuedAgentRuns({
      projectId: PROJECT_ID,
      storage: storage.agents,
      queue: queues.agents,
      limit: 1,
    })

    expect(dispatch.dispatched.map(({ runId }) => runId)).toEqual([cloud.id])
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

  // Removal proof: rethrow from the enqueue catch in dispatchQueuedAgentRuns.
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
