import { afterEach, expect, test } from "bun:test"
import { MercuryApiError, mercury } from "../src"
import { CONTEXT, createTestClient, json, mockFetch, TOKEN } from "./helpers"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("a failing response throws MercuryApiError carrying status, body, and request id", async () => {
  mockFetch(async () =>
    json(
      { errors: { message: "Invalid limit" } },
      { status: 400, headers: { "x-request-id": "req-1" } }
    )
  )
  const mc = await createTestClient()

  const promise = mc.accounts.list()
  await expect(promise).rejects.toBeInstanceOf(MercuryApiError)
  await expect(promise).rejects.toThrow(
    "[SixbMercury] Mercury API request failed with 400: Invalid limit"
  )

  const error = (await promise.catch((caught: unknown) => caught)) as MercuryApiError
  expect(error.status).toBe(400)
  expect(error.requestId).toBe("req-1")
})

test("retryAfterMs is parsed from the Retry-After header", async () => {
  mockFetch(async () =>
    json({ message: "Slow down" }, { status: 429, headers: { "retry-after": "2" } })
  )
  const mc = await createTestClient({ retry: { maxRetries: 0 } })

  const error = (await mc.accounts.list().catch((caught: unknown) => caught)) as MercuryApiError
  expect(error.status).toBe(429)
  expect(error.retryAfterMs).toBe(2000)
})

test("a 429 on a read is retried and honors Retry-After", async () => {
  let attempts = 0
  mockFetch(async () => {
    attempts += 1
    return attempts === 1
      ? json({ message: "Slow down" }, { status: 429, headers: { "retry-after": "0" } })
      : json({ accounts: [], page: {} })
  })
  const mc = await createTestClient()

  await mc.accounts.list()

  expect(attempts).toBe(2)
})

test("a 5xx on a read is retried", async () => {
  let attempts = 0
  mockFetch(async () => {
    attempts += 1
    return attempts < 3
      ? json({ message: "Boom" }, { status: 503 })
      : json({ accounts: [], page: {} })
  })
  const mc = await createTestClient({ retry: { maxRetries: 2, delayMs: () => 0 } })

  await mc.accounts.list()

  expect(attempts).toBe(3)
})

test("retries stop at maxRetries and surface the final failure", async () => {
  let attempts = 0
  mockFetch(async () => {
    attempts += 1
    return json({ message: "Boom" }, { status: 500 })
  })
  const mc = await createTestClient({ retry: { maxRetries: 1, delayMs: () => 0 } })

  await expect(mc.accounts.list()).rejects.toBeInstanceOf(MercuryApiError)
  expect(attempts).toBe(2)
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

test("an aborted request is not retried", async () => {
  let attempts = 0
  mockFetch(async () => {
    attempts += 1
    throw new DOMException("The operation was aborted.", "AbortError")
  })
  const mc = await createTestClient({ retry: { delayMs: () => 0 } })

  await expect(mc.accounts.list()).rejects.toThrow(/aborted/)
  expect(attempts).toBe(1)
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
  const startedAt: number[] = []
  mockFetch(async () => {
    startedAt.push(Date.now())
    return json({ accounts: [], page: {} })
  })
  const mc = await createTestClient({ minDelayMs: 40 })

  await Promise.all([mc.accounts.list(), mc.accounts.list()])

  expect(startedAt).toHaveLength(2)
  expect((startedAt[1] ?? 0) - (startedAt[0] ?? 0)).toBeGreaterThanOrEqual(30)
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

test("an async accessToken resolver is called per attempt, supporting rotation", async () => {
  const tokens = ["secret-token:first", "secret-token:second"]
  const seen: (string | null)[] = []
  let attempts = 0
  mockFetch(async (_input, init) => {
    seen.push(new Headers(init?.headers).get("authorization"))
    attempts += 1
    return attempts === 1
      ? json({ message: "Boom" }, { status: 500 })
      : json({ accounts: [], page: {} })
  })

  const mc = await mercury({
    accessToken: () => tokens[Math.min(attempts, tokens.length - 1)] as string,
    retry: { maxRetries: 1, delayMs: () => 0 },
  }).connect(CONTEXT)
  await mc.accounts.list()

  expect(seen).toEqual(["Bearer secret-token:first", "Bearer secret-token:second"])
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

test("a non-JSON error body is surfaced verbatim", async () => {
  mockFetch(async () => new Response("upstream unavailable", { status: 502 }))
  const mc = await createTestClient({ retry: { maxRetries: 0 } })

  await expect(mc.accounts.list()).rejects.toThrow(
    "[SixbMercury] Mercury API request failed with 502: upstream unavailable"
  )
})
