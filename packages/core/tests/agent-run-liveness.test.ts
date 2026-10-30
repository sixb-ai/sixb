import { describe, expect, test } from "bun:test"
import { InMemoryBroker, InMemoryStorage, type SecurityDefinitionCatalog } from "../src"
import { createAgentRunExecutionToken, endLapsedAgentRuns, NOOP_STREAM_SINK } from "../src/agents"
import type { AgentRunRecord } from "../src/storage/agents"
import { createTestAgentExecution } from "../src/testing"

const PROJECT_ID = "agent-run-liveness-tests"
const LEASE_MS = 60_000

function setup() {
  const storage = new InMemoryStorage()
  const finished: AgentRunRecord[] = []
  const host = {
    projectId: PROJECT_ID,
    storage,
    broker: new InMemoryBroker(),
    recoverAiModelCall: async () => {},
    events: {
      ...NOOP_STREAM_SINK,
      async publishRunFinished(run: AgentRunRecord) {
        finished.push(run)
      },
    },
    security: { groups: [], roles: [] } as unknown as SecurityDefinitionCatalog,
  }

  /** A turn some runner started, holding it until `leaseExpiresAt`; or still queued. */
  const turn = async (id: string, leaseExpiresAt?: Date) => {
    await storage.agents.threads.create({
      id: `thread-${id}`,
      projectId: PROJECT_ID,
      ownerPrincipal: { type: "system", id: "system" },
    })
    const executionId = await createTestAgentExecution(storage, {
      projectId: PROJECT_ID,
      runId: id,
    })
    const run = await storage.agents.runs.create({
      id,
      projectId: PROJECT_ID,
      executionId,
      threadId: `thread-${id}`,
      triggerMessageId: `message-${id}`,
      spec: { model: { provider: "test", modelId: "test-model" } },
    })
    if (!leaseExpiresAt) return run
    return storage.agents.runs.start({
      projectId: PROJECT_ID,
      id,
      execution: { token: createAgentRunExecutionToken(), queueLeaseExpiresAt: leaseExpiresAt },
    })
  }
  const read = async (id: string) => {
    const run = await storage.agents.runs.getById({ projectId: PROJECT_ID, id })
    if (!run) throw new Error(`Expected run '${id}'.`)
    return run
  }
  return { storage, host, finished, turn, read }
}

describe("endLapsedAgentRuns", () => {
  // Guard proof: drop "conversation" from the kinds it lists, and the lapsed turn stays running.
  test("ends a running turn whose lease lapsed, and leaves held and queued ones", async () => {
    const { host, finished, turn, read, storage } = setup()
    const lapsed = await turn("run-lapsed", new Date(Date.now() - 1))
    await turn("run-held", new Date(Date.now() + LEASE_MS))
    await turn("run-queued")

    expect(await endLapsedAgentRuns(host, { leaseMs: LEASE_MS })).toBe(1)

    expect(await read("run-lapsed")).toMatchObject({
      status: "cancelled",
      finishReason: "interrupted",
      attempt: 2,
      error: { code: "runtime.cancelled" },
    })
    expect((await read("run-held")).status).toBe("running")
    expect((await read("run-queued")).status).toBe("queued")
    expect(finished.map((run) => run.id)).toEqual(["run-lapsed"])
    // The claim rotated the token first: the runner that held the turn can write nothing.
    const stale = await storage.agents.runs
      .finish({
        projectId: PROJECT_ID,
        id: lapsed.id,
        executionToken: lapsed.execution?.token ?? "",
        status: "succeeded",
      })
      .catch((error: unknown) => error)
    expect(stale).toBeInstanceOf(Error)
  })

  // Guard proof: return after the first page, and the lapsed turn past it is never ended.
  test("reads past a page of runs that are still held", async () => {
    const { host, turn, read } = setup()
    for (let index = 0; index < 100; index += 1) {
      await turn(`run-held-${String(index).padStart(3, "0")}`, new Date(Date.now() + LEASE_MS))
    }
    await turn("run-lapsed", new Date(Date.now() - 1))

    expect(await endLapsedAgentRuns(host, { leaseMs: LEASE_MS })).toBe(1)
    expect((await read("run-lapsed")).status).toBe("cancelled")
  })
})
