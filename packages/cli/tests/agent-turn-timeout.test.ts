import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { resolveAgentTurnTimeoutMs } from "../src/lib/agent-turn-timeout"

describe("resolveAgentTurnTimeoutMs", () => {
  const originalTimeout = process.env.SIXB_AGENT_TURN_TIMEOUT

  beforeEach(() => {
    delete process.env.SIXB_AGENT_TURN_TIMEOUT
  })

  afterEach(() => {
    if (originalTimeout === undefined) {
      delete process.env.SIXB_AGENT_TURN_TIMEOUT
    } else {
      process.env.SIXB_AGENT_TURN_TIMEOUT = originalTimeout
    }
  })

  test("leaves the AgentWorker default in authority when nothing is configured", () => {
    expect(resolveAgentTurnTimeoutMs(undefined)).toBeUndefined()
  })

  test("parses human-readable CLI durations", () => {
    expect(resolveAgentTurnTimeoutMs("250ms")).toBe(250)
    expect(resolveAgentTurnTimeoutMs("30s")).toBe(30_000)
    expect(resolveAgentTurnTimeoutMs("10m")).toBe(600_000)
    expect(resolveAgentTurnTimeoutMs("1h")).toBe(3_600_000)
  })

  test("uses the environment when the flag is absent and lets the flag take precedence", () => {
    process.env.SIXB_AGENT_TURN_TIMEOUT = "20m"

    expect(resolveAgentTurnTimeoutMs(undefined)).toBe(1_200_000)
    expect(resolveAgentTurnTimeoutMs("45s")).toBe(45_000)
  })

  test("rejects malformed, zero, and timer-overflowing durations", () => {
    expect(() => resolveAgentTurnTimeoutMs("soon")).toThrow("Invalid agent turn timeout 'soon'")
    expect(() => resolveAgentTurnTimeoutMs("0m")).toThrow("Invalid agent turn timeout '0m'")
    expect(() => resolveAgentTurnTimeoutMs("1000h")).toThrow("Invalid agent turn timeout '1000h'")
  })
})
