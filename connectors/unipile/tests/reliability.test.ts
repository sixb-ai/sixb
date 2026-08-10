import { afterEach, describe, expect, test } from "bun:test"
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
})

test("safe synchronized reads retry transient failures", async () => {
  const calls = recorder([
    json({ message: "slow down" }, { status: 429, headers: { "retry-after": "0" } }),
    json({ object: "AccountList", items: [], cursor: null }),
  ])
  const client = await createTestClient({ retry: { maxRetries: 1, delayMs: () => 0 } })

  await client.accounts.list()

  expect(calls).toHaveLength(2)
})

test("the token resolver runs for every safe-read attempt", async () => {
  let resolutions = 0
  recorder([
    json({ message: "temporary" }, { status: 500 }),
    json({ object: "AccountList", items: [], cursor: null }),
  ])
  const client = await createTestClient({
    accessToken: () => `token-${++resolutions}`,
    retry: { maxRetries: 1, delayMs: () => 0 },
  })

  await client.accounts.list()

  expect(resolutions).toBe(2)
})

test("LinkedIn search never retries even when the policy asks to", async () => {
  const calls = recorder(() => json({ message: "temporary" }, { status: 500 }))
  const client = await createTestClient({
    retry: { maxRetries: 5, shouldRetry: () => true, delayMs: () => 0 },
  })

  await expect(
    client.linkedin.searchPeople({
      account_id: "account-1",
      url: "https://www.linkedin.com/search/results/people/?keywords=founder",
    })
  ).rejects.toBeInstanceOf(UnipileApiError)
  expect(calls).toHaveLength(1)
})

test("writes never retry even when the policy asks to", async () => {
  const calls = recorder(() => json({ message: "temporary" }, { status: 500 }))
  const client = await createTestClient({
    retry: { maxRetries: 5, shouldRetry: () => true, delayMs: () => 0 },
  })

  await expect(
    client.users.sendInvitation({ account_id: "account-1", provider_id: "ACo1" })
  ).rejects.toBeInstanceOf(UnipileApiError)
  expect(calls).toHaveLength(1)
})

test("paces concurrently initiated requests", async () => {
  const startedAt: number[] = []
  mockFetch(() => {
    startedAt.push(performance.now())
    return Promise.resolve(json({ object: "AccountList", items: [], cursor: null }))
  })

  const client = await createTestClient({ minDelayMs: 20 })
  await Promise.all([client.accounts.list(), client.accounts.list(), client.accounts.list()])

  // Regression: forwarding minDelayMs to the REST client makes calls two and three share a
  // deadline and start together. The connector-level scheduler must reserve separate start slots.
  expect(startedAt).toHaveLength(3)
  expect((startedAt[1] ?? 0) - (startedAt[0] ?? 0)).toBeGreaterThanOrEqual(15)
  expect((startedAt[2] ?? 0) - (startedAt[1] ?? 0)).toBeGreaterThanOrEqual(15)
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

for (const [status, body] of [
  [429, { code: "rate_limited", message: "Too many requests" }],
  [500, { code: "provider_error", message: "LinkedIn unavailable" }],
] as const) {
  test(`UnipileApiError preserves a ${status} response body`, async () => {
    mockFetch(() => Promise.resolve(json(body, { status })))
    const client = await createTestClient()

    let caught: unknown
    try {
      await client.users.sendInvitation({ account_id: "account-1", provider_id: "ACo1" })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(UnipileApiError)
    expect((caught as UnipileApiError).status).toBe(status)
    expect((caught as UnipileApiError).responseBody).toEqual(body)
  })
}

describe("connector validation", () => {
  test("rejects a DSN path so v1 is not appended twice", () => {
    expect(() => unipile({ dsn: `${DSN}/api/v1`, accessToken: TOKEN })).toThrow(
      "dsn must be an origin"
    )
  })

  test("rejects empty credentials", () => {
    expect(() => unipile({ dsn: DSN, accessToken: "" })).toThrow("accessToken must not be empty")
  })

  test("rejects an empty token returned by a resolver", async () => {
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
