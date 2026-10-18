import { afterEach, expect, jest, test } from "bun:test"
import type { AceIotClient } from "../src"
import { AceIotApiError, AceIotConfigurationError, aceIot } from "../src"
import { API_KEY, CONTEXT, createTestClient, json, mockFetch, page } from "./helpers"

const originalFetch = globalThis.fetch

afterEach(() => {
  jest.useRealTimers()
  globalThis.fetch = originalFetch
})

/** Drain pending microtasks; setImmediate is not faked, so it also works under fake timers. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

test("the key, static or resolved per request, is sent as Bearer auth, which ACE requires", async () => {
  const headers: Headers[] = []
  mockFetch((_input, init) => {
    headers.push(new Headers(init?.headers))
    return Promise.resolve(json(page([])))
  })

  await (await createTestClient()).sites.list()

  // A resolver is called for every request, so key rotation needs no reconnect.
  let issued = 0
  const rotating = await aceIot({ apiKey: async () => `rotating-${++issued}` }).connect(CONTEXT)
  await rotating.sites.list()
  await rotating.sites.list()

  // ACE rejects a bare token even though its own spec calls this an apiKey header.
  expect(headers.map((sent) => sent.get("authorization"))).toEqual([
    `Bearer ${API_KEY}`,
    "Bearer rotating-1",
    "Bearer rotating-2",
  ])
  expect(headers[0].get("accept")).toBe("application/json")
})

const VALIDATION_DETAIL =
  "Results per page {error_msg} The value '7' is not a valid choice for 'per_page'."

test.each([
  [
    "a bare message",
    404,
    { message: "A database result was required but none was found." },
    {},
    {
      message:
        "[SixbAceIot] ACE API request failed with 404: A database result was required but none was found.",
    },
  ],
  [
    "Flask-RESTX field validation",
    400,
    { errors: { per_page: VALIDATION_DETAIL }, message: "Input payload validation failed" },
    {},
    {
      message: `[SixbAceIot] ACE API request failed with 400: Input payload validation failed (per_page: ${VALIDATION_DETAIL})`,
      validationErrors: { per_page: VALIDATION_DETAIL },
    },
  ],
  [
    // Verified live: an invalid ACE key answers 500 with Flask's generic message, not 401.
    "Flask's generic 500, which a bad key also produces",
    500,
    { message: "An unhandled exception occurred." },
    {},
    {
      message:
        "[SixbAceIot] ACE API request failed with 500: An unhandled exception occurred. ACE also returns this when the API key is invalid.",
    },
  ],
  [
    "an unrelated 500, which gets no key hint",
    500,
    { message: "Upstream timeout" },
    {},
    { message: "[SixbAceIot] ACE API request failed with 500: Upstream timeout" },
  ],
  [
    "a 429 with Retry-After",
    429,
    { message: "Slow down" },
    { "retry-after": "2" },
    { message: "[SixbAceIot] ACE API request failed with 429: Slow down", retryAfterMs: 2000 },
  ],
] as const)("%s throws AceIotApiError carrying status, body, and detail", async (_name, status, body, headers, expected) => {
  mockFetch(async () => json(body, { status, headers }))
  const ace = await createTestClient({ retry: { maxRetries: 0 } })

  const error = await ace.sites.list().catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(AceIotApiError)
  expect(error).toMatchObject({
    status,
    responseBody: body,
    message: expected.message,
    retryAfterMs: "retryAfterMs" in expected ? expected.retryAfterMs : null,
    validationErrors: "validationErrors" in expected ? expected.validationErrors : null,
  })
})

test("a 429 on a read is retried after the Retry-After delay", async () => {
  let attempts = 0
  mockFetch(async () => {
    attempts += 1
    return attempts === 1
      ? json({ message: "Slow down" }, { status: 429, headers: { "retry-after": "2" } })
      : json(page([]))
  })
  const ace = await createTestClient()

  jest.useFakeTimers()
  const listed = ace.sites.list()
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
  const ace = await createTestClient({ retry: { delayMs: () => 0 } })

  await expect(ace.sites.list()).rejects.toBeInstanceOf(AceIotApiError)
  expect(attempts).toBe(3)
})

test.each([
  [
    "a point batch write",
    (ace: AceIotClient) =>
      ace.points.create([{ name: "client/site/dev/analogInput/1", collect_enabled: true }]),
  ],
  // A replay would issue a second credential.
  ["minting a gateway token", (ace: AceIotClient) => ace.gateways.createToken("gw")],
])("%s is never replayed, because every ACE write changes state", async (_name, write) => {
  let attempts = 0
  mockFetch(async () => {
    attempts += 1
    return json({ message: "Boom" }, { status: 503 })
  })
  const ace = await createTestClient({ retry: { delayMs: () => 0 } })

  await expect(write(ace)).rejects.toBeInstanceOf(AceIotApiError)

  expect(attempts).toBe(1)
})

test("the point-batch timeseries read is retried even though it is a POST", async () => {
  let attempts = 0
  mockFetch(async () => {
    attempts += 1
    return attempts < 3 ? json({ message: "Boom" }, { status: 503 }) : json({ point_samples: [] })
  })
  const ace = await createTestClient({ retry: { delayMs: () => 0 } })

  await ace.points.getTimeseriesForPoints(["client/site/dev/analogInput/1"], {
    startTime: "2026-08-07T17:00:00Z",
    endTime: "2026-08-07T18:00:00Z",
  })

  expect(attempts).toBe(3)
})

test("a custom retry policy replaces the default decision", async () => {
  const seen: Array<{ method: string; idempotent: boolean; status: number | undefined }> = []
  let attempts = 0
  mockFetch(async () => {
    attempts += 1
    return attempts === 1 ? json({ message: "Boom" }, { status: 400 }) : json({ ok: true })
  })
  const ace = await createTestClient({
    retry: {
      maxRetries: 1,
      delayMs: () => 0,
      shouldRetry(context) {
        seen.push({
          method: context.method,
          idempotent: context.idempotent,
          status: context.response?.status,
        })
        return context.response?.status === 400
      },
    },
  })

  await ace.gateways.update("gw", { archived: true })

  expect(attempts).toBe(2)
  expect(seen[0]).toEqual({ method: "PATCH", idempotent: false, status: 400 })
})

test("minDelayMs spaces request starts", async () => {
  let starts = 0
  mockFetch(async () => {
    starts += 1
    return json(page([]))
  })
  const ace = await createTestClient({ minDelayMs: 40 })

  jest.useFakeTimers()
  const listed = Promise.all([ace.sites.list(), ace.sites.list()])
  await settle()
  expect(starts).toBe(1)

  jest.advanceTimersByTime(39)
  await settle()
  expect(starts).toBe(1)

  jest.advanceTimersByTime(1)
  await listed
  expect(starts).toBe(2)
})

test("an empty or non-string key is rejected before any request", () => {
  expect(() => aceIot({ apiKey: "   " })).toThrow(AceIotConfigurationError)
  expect(() => aceIot({ apiKey: "   " })).toThrow("[SixbAceIot] apiKey must not be empty.")
  expect(() => aceIot({ apiKey: 42 as unknown as string })).toThrow(
    "[SixbAceIot] apiKey must be a string or a function."
  )
})

test("a resolver returning an empty key fails at once instead of burning retry backoff", async () => {
  let attempts = 0
  mockFetch(async () => {
    attempts += 1
    return json(page([]))
  })
  const ace = await aceIot({ apiKey: () => "" }).connect(CONTEXT)

  const promise = ace.sites.list()
  await expect(promise).rejects.toBeInstanceOf(AceIotConfigurationError)
  await expect(promise).rejects.toThrow("[SixbAceIot] apiKey must not be empty.")
  expect(attempts).toBe(0)
})

test("a resolver that fails for its own reasons is retried like any read", async () => {
  // A token endpoint can fail transiently, so only the connector's own config checks skip retry.
  let resolves = 0
  mockFetch(async () => json(page([])))
  const ace = await aceIot({
    apiKey: () => {
      resolves += 1
      if (resolves < 3) throw new TypeError("token endpoint unreachable")
      return "recovered-key"
    },
    retry: { delayMs: () => 0 },
  }).connect(CONTEXT)

  await ace.sites.list()

  expect(resolves).toBe(3)
})

test("a base URL without a trailing slash still keeps its path prefix", async () => {
  let requested = ""
  mockFetch((input) => {
    requested = String(input)
    return Promise.resolve(json(page([])))
  })

  const ace = await aceIot({
    apiKey: API_KEY,
    baseUrl: "https://ace.example.com/api",
  }).connect(CONTEXT)
  await ace.sites.list()

  expect(new URL(requested).pathname).toBe("/api/sites/")
})

test("retry.maxRetries is validated", async () => {
  await expect(createTestClient({ retry: { maxRetries: -1 } })).rejects.toThrow(
    "[SixbAceIot] retry.maxRetries must be a non-negative integer."
  )
})
