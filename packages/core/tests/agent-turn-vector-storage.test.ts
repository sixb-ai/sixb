import { afterEach, describe, expect, jest, mock, spyOn, test } from "bun:test"
import { InMemoryStorage } from "../src"
import {
  cachedTurnVectorSearchProbe,
  TURN_VECTOR_SEARCH_PROBE_RETRY_MS,
} from "../src/storage/agents/provider"
import { runAgentTurnVectorStorageContractSuite } from "../src/testing"

runAgentTurnVectorStorageContractSuite("InMemoryAgentTurnVectorStore", {
  createStorage: () => new InMemoryStorage(),
})

describe("cachedTurnVectorSearchProbe", () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  test("remembers a yes, and asks again after a no once a few minutes passed", async () => {
    // Guard proof: remember every answer for good; the extension installed later is never seen.
    jest.useFakeTimers({ now: new Date("2026-11-20T09:00:00.000Z") })
    const answers = [false, true]
    const probe = mock(async () => answers.shift()!)
    const searchAvailable = cachedTurnVectorSearchProbe(probe)

    expect(await searchAvailable()).toBe(false)
    expect(await searchAvailable()).toBe(false)
    expect(probe).toHaveBeenCalledTimes(1)

    jest.advanceTimersByTime(TURN_VECTOR_SEARCH_PROBE_RETRY_MS)
    expect(await searchAvailable()).toBe(true)

    jest.advanceTimersByTime(10 * TURN_VECTOR_SEARCH_PROBE_RETRY_MS)
    expect(await searchAvailable()).toBe(true)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  test("asks again right after a probe that failed", async () => {
    // Guard proof: remember the failure as a no; the second call answers false without asking.
    jest.useFakeTimers({ now: new Date("2026-11-20T09:00:00.000Z") })
    const answers: (boolean | Error)[] = [new Error("connection reset"), true]
    const probe = mock(async () => {
      const answer = answers.shift()!
      if (answer instanceof Error) throw answer
      return answer
    })
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    const searchAvailable = cachedTurnVectorSearchProbe(probe)

    try {
      expect(await searchAvailable()).toBe(false)
      expect(warn).toHaveBeenCalledTimes(1)

      expect(await searchAvailable()).toBe(true)
      expect(probe).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
    }
  })
})
