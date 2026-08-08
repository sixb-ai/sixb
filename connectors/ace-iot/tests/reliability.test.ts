import { afterEach, expect, test } from "bun:test"
import { AceIotApiError, AceIotConfigurationError, aceIot } from "../src"
import { API_KEY, CONTEXT, createTestClient, json, mockFetch, page } from "./helpers"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("the key is sent as Bearer auth, which ACE requires despite calling it an apiKey header", async () => {
  let headers = new Headers()
  mockFetch((_input, init) => {
    headers = new Headers(init?.headers)
    return Promise.resolve(json(page([])))
  })

  const ace = await createTestClient()
  await ace.sites.list()

  expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`)
  expect(headers.get("accept")).toBe("application/json")
})

test("an async key resolver is called for every attempt, so rotation needs no reconnect", async () => {
  const keys: string[] = []
  let issued = 0
  mockFetch((_input, init) => {
    keys.push(new Headers(init?.headers).get("authorization") ?? "")
    return Promise.resolve(json(page([])))
  })

  const ace = await aceIot({
    apiKey: async () => `rotating-${++issued}`,
  }).connect(CONTEXT)
  await ace.sites.list()
  await ace.sites.list()

  expect(keys).toEqual(["Bearer rotating-1", "Bearer rotating-2"])
})

test("a failing response throws AceIotApiError carrying status and parsed body", async () => {
  mockFetch(async () =>
    json({ message: "A database result was required but none was found." }, { status: 404 })
  )
  const ace = await createTestClient()

  const promise = ace.points.get("client/site/dev/analogInput/1")
  await expect(promise).rejects.toBeInstanceOf(AceIotApiError)
  await expect(promise).rejects.toThrow(
    "[SixbAceIot] ACE API request failed with 404: A database result was required but none was found."
  )

  const error = (await promise.catch((caught: unknown) => caught)) as AceIotApiError
  expect(error.status).toBe(404)
  expect(error.responseBody).toEqual({
    message: "A database result was required but none was found.",
  })
})

test("Flask-RESTX field validation is surfaced through validationErrors", async () => {
  mockFetch(async () =>
    json(
      {
        errors: {
          per_page:
            "Results per page {error_msg} The value '7' is not a valid choice for 'per_page'.",
        },
        message: "Input payload validation failed",
      },
      { status: 400 }
    )
  )
  const ace = await createTestClient()

  const error = (await ace.sites.get("site").catch((caught: unknown) => caught)) as AceIotApiError

  expect(error.status).toBe(400)
  expect(error.validationErrors).toEqual({
    per_page: "Results per page {error_msg} The value '7' is not a valid choice for 'per_page'.",
  })
  expect(error.message).toContain("Input payload validation failed")
  expect(error.message).toContain("per_page:")
})

test("a 500 carrying Flask's generic message says that a bad key also produces it", async () => {
  // Verified live: an invalid ACE key answers 500, not 401.
  mockFetch(async () => json({ message: "An unhandled exception occurred." }, { status: 500 }))
  const ace = await createTestClient({ retry: { maxRetries: 0 } })

  const error = (await ace.sites.list().catch((caught: unknown) => caught)) as AceIotApiError

  expect(error.status).toBe(500)
  expect(error.message).toBe(
    "[SixbAceIot] ACE API request failed with 500: An unhandled exception occurred. ACE also returns this when the API key is invalid."
  )
})

test("a 500 on an unrelated message gets no key hint", async () => {
  mockFetch(async () => json({ message: "Upstream timeout" }, { status: 500 }))
  const ace = await createTestClient({ retry: { maxRetries: 0 } })

  const error = (await ace.sites.list().catch((caught: unknown) => caught)) as AceIotApiError
  expect(error.message).toBe("[SixbAceIot] ACE API request failed with 500: Upstream timeout")
})

test("retryAfterMs is parsed from the Retry-After header", async () => {
  mockFetch(async () =>
    json({ message: "Slow down" }, { status: 429, headers: { "retry-after": "2" } })
  )
  const ace = await createTestClient({ retry: { maxRetries: 0 } })

  const error = (await ace.sites.list().catch((caught: unknown) => caught)) as AceIotApiError
  expect(error.retryAfterMs).toBe(2000)
})

test("a 429 on a read is retried and honors Retry-After", async () => {
  let attempts = 0
  mockFetch(async () => {
    attempts += 1
    return attempts === 1
      ? json({ message: "Slow down" }, { status: 429, headers: { "retry-after": "0" } })
      : json(page([]))
  })
  const ace = await createTestClient()

  await ace.sites.list()

  expect(attempts).toBe(2)
})

test("a 5xx on a read is retried up to maxRetries and then surfaces", async () => {
  let attempts = 0
  mockFetch(async () => {
    attempts += 1
    return json({ message: "Boom" }, { status: 503 })
  })
  const ace = await createTestClient({ retry: { maxRetries: 2, delayMs: () => 0 } })

  await expect(ace.sites.list()).rejects.toBeInstanceOf(AceIotApiError)
  expect(attempts).toBe(3)
})

test("a network error on a read is retried", async () => {
  let attempts = 0
  mockFetch(async () => {
    attempts += 1
    if (attempts < 3) throw new TypeError("network down")
    return json(page([]))
  })
  const ace = await createTestClient({ retry: { delayMs: () => 0 } })

  await ace.sites.list()

  expect(attempts).toBe(3)
})

test("writes are never replayed, because every ACE write changes state", async () => {
  let attempts = 0
  mockFetch(async () => {
    attempts += 1
    return json({ message: "Boom" }, { status: 503 })
  })
  const ace = await createTestClient({ retry: { delayMs: () => 0 } })

  await expect(
    ace.points.create([{ name: "client/site/dev/analogInput/1", collect_enabled: true }])
  ).rejects.toBeInstanceOf(AceIotApiError)

  expect(attempts).toBe(1)
})

test("minting a gateway token is never replayed", async () => {
  let attempts = 0
  mockFetch(async () => {
    attempts += 1
    return json({ message: "Boom" }, { status: 500 })
  })
  const ace = await createTestClient({ retry: { delayMs: () => 0 } })

  await expect(ace.gateways.createToken("gw")).rejects.toBeInstanceOf(AceIotApiError)

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

test("an aborted request is not retried", async () => {
  let attempts = 0
  mockFetch(async () => {
    attempts += 1
    throw new DOMException("aborted", "AbortError")
  })
  const ace = await createTestClient({ retry: { delayMs: () => 0 } })

  await expect(ace.sites.list()).rejects.toThrow("aborted")
  expect(attempts).toBe(1)
})

test("minDelayMs spaces request starts", async () => {
  const starts: number[] = []
  mockFetch(async () => {
    starts.push(Date.now())
    return json(page([]))
  })
  const ace = await createTestClient({ minDelayMs: 40 })

  await Promise.all([ace.sites.list(), ace.sites.list(), ace.sites.list()])

  expect(starts).toHaveLength(3)
  expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(30)
  expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(30)
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
