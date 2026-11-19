import { afterEach, describe, expect, jest, spyOn, test } from "bun:test"
import {
  lostConnectionCode,
  MODEL_CALL_RETRY,
  modelCallInterrupted,
  modelCallRetryDelay,
} from "../src/agents/model-call-retry"
import { ModelProviderError, ModelStreamError } from "../src/models"

function withCode(error: Error, code: string): Error {
  return Object.assign(error, { code })
}

describe("lostConnectionCode", () => {
  // Reproduce: drop a code from CONNECTION_LOST_CODES, or the TypeError cause lookup; its case
  // then reads as an answer and fails the run.
  test.each([
    ["Bun: reset", withCode(new TypeError("ECONNRESET: closed"), "ECONNRESET"), "ECONNRESET"],
    [
      "Bun: refused",
      withCode(new TypeError("ECONNREFUSED: unable to connect"), "ECONNREFUSED"),
      "ECONNREFUSED",
    ],
    ["Bun: timed out", withCode(new TypeError("ETIMEDOUT"), "ETIMEDOUT"), "ETIMEDOUT"],
    [
      "Node: closed socket",
      new TypeError("fetch failed", {
        cause: withCode(new Error("other side closed"), "UND_ERR_SOCKET"),
      }),
      "UND_ERR_SOCKET",
    ],
    [
      "Node: connect timeout",
      new TypeError("fetch failed", {
        cause: withCode(new Error("Connect Timeout Error"), "UND_ERR_CONNECT_TIMEOUT"),
      }),
      "UND_ERR_CONNECT_TIMEOUT",
    ],
  ])("names a connection that failed (%s)", (_, error, code) => {
    expect(lostConnectionCode(error)).toBe(code)
  })

  // Reproduce: look for the code on every error's cause; a model call the limits refused because
  // their own storage connection reset is then made again.
  test.each([
    [
      "an HTTP refusal its binding already retried",
      new ModelProviderError("[test] Service unavailable.", "mock", "model", {
        status: 503,
        retryable: true,
      }),
    ],
    [
      "a request the provider rejected",
      new ModelProviderError("[test] Bad request.", "mock", "model", { status: 400 }),
    ],
    ["a provider that went silent", new ModelStreamError("[test] The model sent nothing.")],
    ["an abort", new DOMException("The operation was aborted.", "AbortError")],
    [
      "a failure caused by some other connection",
      new Error("[test] Limits unavailable.", {
        cause: withCode(new Error("reset"), "ECONNRESET"),
      }),
    ],
    ["a host that does not exist", withCode(new TypeError("ENOTFOUND"), "ENOTFOUND")],
    ["anything else", new Error("[test] boom")],
  ])("names nothing for %s", (_, error) => {
    expect(lostConnectionCode(error)).toBeUndefined()
  })
})

describe("modelCallInterrupted", () => {
  // Reproduce: return true for any ModelProviderError with a reason; a request too long for the
  // model is then made again, unchanged, instead of being compacted.
  test.each([
    ["a lost connection", withCode(new TypeError("ECONNRESET: closed"), "ECONNRESET"), true],
    [
      "a response its provider interrupted",
      new ModelProviderError("[test] Overloaded.", "mock", "model", {
        code: "overloaded_error",
        reason: "interrupted",
      }),
      true,
    ],
    [
      "a request too long for the model",
      new ModelProviderError("[test] Too long.", "mock", "model", {
        reason: "context-window-exceeded",
      }),
      false,
    ],
    [
      "an HTTP refusal its binding already retried",
      new ModelProviderError("[test] Overloaded.", "mock", "model", {
        status: 529,
        code: "overloaded_error",
        retryable: true,
      }),
      false,
    ],
  ])("says whether %s was interrupted", (_, error, interrupted) => {
    expect(modelCallInterrupted(error)).toBe(interrupted)
  })
})

describe("modelCallRetryDelay", () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  // Reproduce: return the policy's delay without its jitter; the lowest draw then waits it whole.
  test("waits between half and all of a delay that doubles up to its maximum", () => {
    spyOn(Math, "random").mockReturnValue(0)
    expect([0, 1, 2, 3, 4].map(modelCallRetryDelay)).toEqual([500, 1_000, 2_000, 4_000, 4_000])

    spyOn(Math, "random").mockReturnValue(0.999_999)
    expect([0, 1, 2, 3, 4].map(modelCallRetryDelay)).toEqual([1_000, 2_000, 4_000, 8_000, 8_000])
    expect(MODEL_CALL_RETRY.retries).toBe(4)
  })
})
