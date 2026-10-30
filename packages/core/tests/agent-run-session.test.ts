import { afterEach, describe, expect, jest, test } from "bun:test"
import { AgentFinalizationError, claimAgentRun } from "../src/agents"
import { describeAgentRunSessionContract, seedAgentRun } from "./agent-run-session-contract"

const LEASE = "2099-01-01T00:00:00.000Z"

afterEach(() => {
  jest.useRealTimers()
})

describeAgentRunSessionContract(claimAgentRun)

// How the in-process session uses storage itself: a session over HTTP retries on its own terms.
describe("an in-process run session", () => {
  test("retries a transient storage failure, and gives up after 850ms", async () => {
    const { host, storage, run } = await seedAgentRun()
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

    const { host: downHost, storage: down, run: other } = await seedAgentRun("run-2")
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

  // The worker asks for its model inside its preparation, which retries a blip in place. Cache the
  // rejected read of the run's model-call accounting in the session; the second ask fails too.
  test("reads the run's model-call accounting on first use, again after a failed read", async () => {
    const { host, storage, run } = await seedAgentRun()
    const session = await claimAgentRun(host, { run, leaseExpiresAt: LEASE })
    if (!session) throw new Error("Expected the run to be claimed.")
    const getById = storage.executions.getById.bind(storage.executions)
    let failures = 1
    storage.executions.getById = async (input) => {
      if (failures-- > 0) throw new Error("storage blip")
      return getById(input)
    }

    const ref = { provider: "test", modelId: "test-model" }
    expect(await session.models.language(ref).catch((error: unknown) => error)).toBeInstanceOf(
      Error
    )
    expect((await session.models.language(ref)).modelId).toBe("test-model")
    session.close()
  })
})
