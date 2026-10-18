import { afterEach, describe, expect, jest, setSystemTime, test } from "bun:test"
import type { UnipileClient } from "../src"
import { UnipileApiError, unipile } from "../src"
import {
  CONTEXT,
  createTestClient,
  DSN,
  json,
  mockFetch,
  originalFetch,
  recorder,
  TOKEN,
} from "./helpers"

afterEach(() => {
  globalThis.fetch = originalFetch
  jest.useRealTimers()
  setSystemTime()
})

test.each([429, 500])("synchronized reads retry a %d with a fresh token", async (status) => {
  let resolutions = 0
  const calls = recorder([
    json({ message: "temporary" }, { status }),
    json({ object: "AccountList", items: [], cursor: null }),
  ])
  const client = await createTestClient({
    accessToken: () => `token-${++resolutions}`,
    retry: { maxRetries: 1, delayMs: () => 0 },
  })

  await client.accounts.list()

  expect(calls.map((call) => call.headers.get("x-api-key"))).toEqual(["token-1", "token-2"])
})

test.each([
  {
    operation: "LinkedIn search",
    run: (client: UnipileClient) =>
      client.linkedin.searchPeople({
        account_id: "account-1",
        url: "https://www.linkedin.com/search/results/people/?keywords=founder",
      }),
  },
  {
    operation: "an invitation",
    run: (client: UnipileClient) =>
      client.users.sendInvitation({ account_id: "account-1", provider_id: "ACo1" }),
  },
])("$operation never retries even when the policy asks to", async ({ run }) => {
  const calls = recorder(() => json({ message: "temporary" }, { status: 500 }))
  const client = await createTestClient({
    retry: { maxRetries: 5, shouldRetry: () => true, delayMs: () => 0 },
  })

  await expect(run(client)).rejects.toBeInstanceOf(UnipileApiError)
  expect(calls).toHaveLength(1)
})

test("paces requests by elapsed time when the wall clock moves forward", async () => {
  jest.useFakeTimers()
  const startedAt: number[] = []
  mockFetch(() => {
    startedAt.push(performance.now())
    return Promise.resolve(json({ object: "AccountList", items: [], cursor: null }))
  })

  setSystemTime(new Date("2026-08-22T12:00:00.000Z"))
  const client = await createTestClient({ minDelayMs: 20 })
  await client.accounts.list()

  // Under fake timers setSystemTime moves only the wall clock; performance.now() advances only
  // when a turn fires the next pacing timer.
  setSystemTime(new Date("2026-08-22T13:00:00.000Z"))
  const second = client.accounts.list()
  for (let turn = 0; turn < 10 && startedAt.length < 2; turn++) {
    await new Promise((resolve) => setImmediate(resolve))
    jest.advanceTimersToNextTimer()
  }
  await second

  // Regression: changing the scheduler back to Date.now() makes the clock jump collapse this gap.
  const [first = 0, next = 0] = startedAt
  expect(startedAt).toHaveLength(2)
  expect(next - first).toBeGreaterThanOrEqual(20)
})

test("UnipileApiError preserves 422 details and request metadata", async () => {
  mockFetch(() =>
    Promise.resolve(
      json(
        { code: "cannot_resend_yet", detail: "Invitation limit reached" },
        {
          status: 422,
          headers: { "x-request-id": "request-1", "retry-after": "3" },
        }
      )
    )
  )
  const client = await createTestClient()

  let caught: unknown
  try {
    await client.users.sendInvitation({ account_id: "account-1", provider_id: "ACo1" })
  } catch (error) {
    caught = error
  }

  expect(caught).toBeInstanceOf(UnipileApiError)
  const error = caught as UnipileApiError
  expect(error.status).toBe(422)
  expect(error.responseBody).toEqual({
    code: "cannot_resend_yet",
    detail: "Invitation limit reached",
  })
  expect(error.requestId).toBe("request-1")
  expect(error.retryAfterMs).toBe(3000)
  expect(error.message).toContain("Invitation limit reached")
})

describe("connector validation", () => {
  test("rejects a DSN path so v1 is not appended twice", () => {
    expect(() => unipile({ dsn: `${DSN}/api/v1`, accessToken: TOKEN })).toThrow(
      "dsn must be an origin"
    )
  })

  test("rejects an empty static token and an empty token returned by a resolver", async () => {
    expect(() => unipile({ dsn: DSN, accessToken: "" })).toThrow("accessToken must not be empty")

    recorder([json({ object: "AccountList", items: [], cursor: null })])
    const client = await unipile({ dsn: DSN, accessToken: () => "" }).connect(CONTEXT)

    await expect(client.accounts.list()).rejects.toThrow("accessToken must not be empty")
  })

  test("rejects invalid retry counts when connecting", async () => {
    await expect(
      unipile({
        dsn: DSN,
        accessToken: TOKEN,
        retry: { maxRetries: -1 },
      }).connect(CONTEXT)
    ).rejects.toThrow("non-negative integer")
  })
})
