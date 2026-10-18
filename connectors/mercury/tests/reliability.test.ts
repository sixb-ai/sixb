import { afterEach, expect, jest, test } from "bun:test"
import { MercuryApiError, mercury } from "../src"
import { CONTEXT, createTestClient, json, mockFetch, TOKEN } from "./helpers"

const originalFetch = globalThis.fetch

afterEach(() => {
  jest.useRealTimers()
  globalThis.fetch = originalFetch
})

/** Drain pending microtasks; setImmediate is not faked, so it also works under fake timers. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

test.each([
  [
    "a validation failure",
    () =>
      json(
        { errors: { message: "Invalid limit" } },
        { status: 400, headers: { "x-request-id": "req-1" } }
      ),
    {
      status: 400,
      responseBody: { errors: { message: "Invalid limit" } },
      message: "[SixbMercury] Mercury API request failed with 400: Invalid limit",
      requestId: "req-1",
      retryAfterMs: null,
    },
  ],
  [
    "a 429 with Retry-After",
    () => json({ message: "Slow down" }, { status: 429, headers: { "retry-after": "2" } }),
    {
      status: 429,
      responseBody: { message: "Slow down" },
      message: "[SixbMercury] Mercury API request failed with 429: Slow down",
      requestId: null,
      retryAfterMs: 2000,
    },
  ],
  [
    "a non-JSON body, surfaced verbatim",
    () => new Response("upstream unavailable", { status: 502 }),
    {
      status: 502,
      responseBody: "upstream unavailable",
      message: "[SixbMercury] Mercury API request failed with 502: upstream unavailable",
      requestId: null,
      retryAfterMs: null,
    },
  ],
])("%s throws MercuryApiError carrying status, body, and request detail", async (_name, response, expected) => {
  mockFetch(async () => response())
  const mc = await createTestClient({ retry: { maxRetries: 0 } })

  const error = await mc.accounts.list().catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(MercuryApiError)
  expect(error).toMatchObject(expected)
})

test("the access token, static or resolved per attempt, is sent exactly as Bearer auth", async () => {
  const seen: (string | null)[] = []
  let attempts = 0
  mockFetch(async (_input, init) => {
    seen.push(new Headers(init?.headers).get("authorization"))
    attempts += 1
    return attempts === 2
      ? json({ message: "Boom" }, { status: 500 })
      : json({ accounts: [], page: {} })
  })

  // The secret-token prefix is part of the token and is sent as provided.
  await (await createTestClient()).accounts.list()

  // A resolver is called for every attempt, so rotation needs no reconnect.
  const tokens = ["secret-token:first", "secret-token:second"]
  const rotating = await mercury({
    accessToken: () => tokens[attempts - 1] as string,
    retry: { maxRetries: 1, delayMs: () => 0 },
  }).connect(CONTEXT)
  await rotating.accounts.list()

  expect(seen).toEqual([
    `Bearer ${TOKEN}`,
    "Bearer secret-token:first",
    "Bearer secret-token:second",
  ])
})

test("a 429 on a read is retried after the Retry-After delay", async () => {
  let attempts = 0
  mockFetch(async () => {
    attempts += 1
    return attempts === 1
      ? json({ message: "Slow down" }, { status: 429, headers: { "retry-after": "2" } })
      : json({ accounts: [], page: {} })
  })
  const mc = await createTestClient()

  jest.useFakeTimers()
  const listed = mc.accounts.list()
  await settle()
  expect(jest.getTimerCount()).toBe(1)

  jest.advanceTimersByTime(1999)
  await settle()
  expect(attempts).toBe(1)

  jest.advanceTimersByTime(1)
  await listed
  expect(attempts).toBe(2)
})

test("a 5xx on a read is retried up to the default two retries and then surfaces", async () => {
  let attempts = 0
  mockFetch(async () => {
    attempts += 1
    return json({ message: "Boom" }, { status: 503 })
  })
  const mc = await createTestClient({ retry: { delayMs: () => 0 } })

  await expect(mc.accounts.list()).rejects.toBeInstanceOf(MercuryApiError)
  expect(attempts).toBe(3)
})

test("writes are never replayed, because Mercury uses POST and PATCH for updates", async () => {
  let attempts = 0
  mockFetch(async () => {
    attempts += 1
    return json({ message: "Boom" }, { status: 503 })
  })
  const mc = await createTestClient({ retry: { delayMs: () => 0 } })

  await expect(mc.transactions.update("t1", { note: "x" })).rejects.toBeInstanceOf(MercuryApiError)
  expect(attempts).toBe(1)

  attempts = 0
  await expect(
    mc.categories.create({
      name: "Travel",
      visibleForReimbursements: true,
      visibleForCardSpend: true,
      visibleForOther: true,
    })
  ).rejects.toBeInstanceOf(MercuryApiError)
  expect(attempts).toBe(1)
})

test("a network error on a read is retried, then rethrown as-is", async () => {
  let attempts = 0
  mockFetch(async () => {
    attempts += 1
    throw new TypeError("network down")
  })
  const mc = await createTestClient({ retry: { maxRetries: 1, delayMs: () => 0 } })

  await expect(mc.accounts.list()).rejects.toThrow("network down")
  expect(attempts).toBe(2)
})

test("a custom shouldRetry overrides the default method-aware policy", async () => {
  let attempts = 0
  mockFetch(async () => {
    attempts += 1
    return attempts === 1 ? json({ message: "Boom" }, { status: 500 }) : json({ ok: true })
  })
  const mc = await createTestClient({
    retry: { maxRetries: 1, delayMs: () => 0, shouldRetry: () => true },
  })

  await mc.transactions.update("t1", { note: "x" })

  expect(attempts).toBe(2)
})

test("minDelayMs spaces consecutive requests", async () => {
  let starts = 0
  mockFetch(async () => {
    starts += 1
    return json({ accounts: [], page: {} })
  })
  const mc = await createTestClient({ minDelayMs: 40 })

  jest.useFakeTimers()
  const listed = Promise.all([mc.accounts.list(), mc.accounts.list()])
  await settle()
  expect(starts).toBe(1)

  jest.advanceTimersByTime(39)
  await settle()
  expect(starts).toBe(1)

  jest.advanceTimersByTime(1)
  await listed
  expect(starts).toBe(2)
})

test("baseUrl can target the sandbox and is normalized to end with a slash", async () => {
  let requested = ""
  mockFetch(async (input) => {
    requested = String(input)
    return json({ accounts: [], page: {} })
  })

  const mc = await mercury({
    accessToken: TOKEN,
    baseUrl: "https://api-sandbox.mercury.com/api/v1",
  }).connect(CONTEXT)
  await mc.accounts.list()

  expect(requested).toStartWith("https://api-sandbox.mercury.com/api/v1/accounts")
})

test("connector options are validated eagerly", () => {
  expect(() => mercury({ accessToken: "  " })).toThrow("accessToken must not be empty")
  expect(() => mercury({ accessToken: 42 as unknown as string })).toThrow(
    "accessToken must be a string or a function"
  )
})

test("invalid retry and delay options are rejected on connect", async () => {
  await expect(createTestClient({ retry: { maxRetries: -1 } })).rejects.toThrow(
    "retry.maxRetries must be a non-negative integer"
  )
  await expect(createTestClient({ minDelayMs: -5 })).rejects.toThrow(
    "minDelayMs must be a non-negative finite number"
  )
})
