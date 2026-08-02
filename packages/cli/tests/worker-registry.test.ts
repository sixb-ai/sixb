import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { SixbCliError } from "../src/lib/errors"
import { assertWorkerInputs } from "../src/lib/worker-registry"

describe("assertWorkerInputs", () => {
  const originalOrigin = process.env.SIXB_API_PUBLIC_ORIGIN

  beforeEach(() => {
    delete process.env.SIXB_API_PUBLIC_ORIGIN
  })

  afterEach(() => {
    if (originalOrigin === undefined) {
      delete process.env.SIXB_API_PUBLIC_ORIGIN
    } else {
      process.env.SIXB_API_PUBLIC_ORIGIN = originalOrigin
    }
  })

  test("passes when every worker can be constructed", () => {
    expect(() =>
      assertWorkerInputs({
        workerTypes: ["sync", "pipeline", "agent"],
        options: { agentApiBaseUrl: "http://localhost:3002" },
        autoSelected: true,
      })
    ).not.toThrow()
  })

  test("passes when the requirement is met by the environment instead of the flag", () => {
    process.env.SIXB_API_PUBLIC_ORIGIN = "http://localhost:3002"

    expect(() =>
      assertWorkerInputs({ workerTypes: ["agent"], options: {}, autoSelected: false })
    ).not.toThrow()
  })

  test("refuses an origin the browser roles would refuse, at the same moment they would", () => {
    // `sixb api` has always rejected a bare host. The agent worker used to accept it and
    // fail at its first request instead, so one `SIXB_API_PUBLIC_ORIGIN` could stop one
    // role at startup and start another. Both now read the same definition.
    process.env.SIXB_API_PUBLIC_ORIGIN = "api.example.com"

    expect(() =>
      assertWorkerInputs({ workerTypes: ["agent"], options: {}, autoSelected: false })
    ).toThrow("Invalid API public origin")
  })

  test("refuses a full URL where an origin is expected", () => {
    expect(() =>
      assertWorkerInputs({
        workerTypes: ["agent"],
        options: { agentApiBaseUrl: "https://api.example.com/api" },
        autoSelected: false,
      })
    ).toThrow("must be an origin")
  })

  test("names what it took down, and how to proceed without it", () => {
    // The whole group refusing is correct: five of six workers running means agent jobs
    // pile up in a queue nobody claims, which looks exactly like an idle system. What was
    // missing is that the operator never asked for an agent worker — auto-discovery did.
    const failure = expectFailure(() =>
      assertWorkerInputs({
        workerTypes: ["sync", "pipeline", "agent"],
        options: {},
        autoSelected: true,
      })
    )

    expect(failure.message).toContain("agent requires --api-public-origin")
    expect(failure.message).toContain("No worker started, including the 2 that were ready")
    expect(failure.message).toContain("(sync, pipeline)")
    // The way forward is a remediation, so the terminal can give it its own place.
    expect(failure.remediation).toContain("`sixb worker-group sync pipeline`")
  })

  test("offers no escape hatch when the operator named the workers", () => {
    const failure = expectFailure(() =>
      assertWorkerInputs({ workerTypes: ["sync", "agent"], options: {}, autoSelected: false })
    )

    expect(failure.message).toContain("agent requires --api-public-origin")
    // Someone who typed `sixb worker-group sync agent` asked for the agent worker.
    // Suggesting they drop it would be answering a question they did not ask.
    expect(failure.remediation).toBeUndefined()
  })

  test("ignores an unknown worker type, which the type resolver already rejects", () => {
    // `resolveWorkerTypeToStart` runs first and refuses unknown names with the list of
    // valid ones. Repeating that check here would give the same mistake two messages.
    expect(() =>
      assertWorkerInputs({ workerTypes: ["not-a-worker"], options: {}, autoSelected: false })
    ).not.toThrow()
  })
})

function expectFailure(run: () => void): SixbCliError {
  try {
    run()
  } catch (error) {
    if (error instanceof SixbCliError) return error
    throw error
  }
  throw new Error("Expected the call to throw a SixbCliError.")
}
